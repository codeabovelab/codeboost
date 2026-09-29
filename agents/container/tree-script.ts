/**
 * The Perl program D runs inside task storage to read it without following links (#66). One program serves three modes,
 * so the seeder's metadata baseline and a later inspection compute the metadata digest the same way:
 *
 * - `digest <root>` prints one SHA-256 over every entry under `root`: its path, inode, mode, owner, size, ctime, mtime,
 *   link target and, outside `objects/`, a regular file's content. Content is hashed rather than trusted to the times,
 *   which a write does not always move; object files are content-addressed and most of the volume, so they are not.
 * - `snapshot <link>...` (in /work) resolves each declared link as the kernel would in an agent container, one part at
 *   a time, and records the state of its target and everything beneath it.
 * - `inspect <base> <link count> <link>... <target>...` (in /work) compares the work tree with the tree of `base`,
 *   hashing every file as a commit would store it, resolves each declared link again (without walking its target), and
 *   reports the state now of each target the snapshot recorded, the metadata digest and HEAD.
 *
 * Output is one JSON document on stdout, at most MAXIMUM_TREE_OUTPUT bytes. A path or link target that is not strict
 * UTF-8 without control characters cannot be put in the manifest (exit 8). More than MAXIMUM_CHANGES changes, more than
 * MAXIMUM_TARGET_ENTRIES target entries, or more output than the bound cannot be returned whole (exit 9). A directory
 * or file it cannot read fails it (exit 6), since what is inside is unknown. Exit 3 is a bad base, exit 4 a Git failure.
 * None of these returns part of the answer.
 */
export const MAXIMUM_CHANGES = 10_000;
/** Entries recorded beneath all declared links' targets together, in one snapshot or inspection. */
export const MAXIMUM_TARGET_ENTRIES = 20_000;
/** Declared links in one snapshot or inspection. */
export const MAXIMUM_DECLARED_LINKS = 200;
/** Bytes in one path or link target the manifest carries; a longer one fails the run (exit 8). */
export const MAXIMUM_NAME_BYTES = 1_024;
// JSON at most doubles a name (a quote or backslash is escaped; control characters are refused). A change carries at
// most three names, a target entry or a link record at most five, each with under 1 KiB of other fields.
const KIB = 1024;
/** The largest output the limits above allow; the script also refuses to print more. */
export const MAXIMUM_TREE_OUTPUT = MAXIMUM_CHANGES * (3 * 2 * MAXIMUM_NAME_BYTES + KIB)
  + MAXIMUM_TARGET_ENTRIES * (5 * 2 * MAXIMUM_NAME_BYTES + KIB) + 2 * MAXIMUM_DECLARED_LINKS * (5 * 2 * MAXIMUM_NAME_BYTES + KIB)
  + 64 * KIB;

export const TREE_SCRIPT = String.raw`
use strict; use warnings;
use Time::HiRes qw(lstat); use Digest::SHA; use JSON::PP; use Encode (); use Fcntl qw(O_RDONLY O_NOFOLLOW);
use IPC::Open2 qw(open2);
$SIG{__WARN__} = sub { die @_ };
my $mode = shift @ARGV // "";
my ($MAXIMUM_CHANGES, $MAXIMUM_TARGET_ENTRIES, $MAXIMUM_NAME_BYTES, $MAXIMUM_OUTPUT) =
  (${MAXIMUM_CHANGES}, ${MAXIMUM_TARGET_ENTRIES}, ${MAXIMUM_NAME_BYTES}, ${MAXIMUM_TREE_OUTPUT});
# An unexpected failure (a warning made fatal, or a die outside an eval) is its own exit status, never a quiet 2 or 255.
$SIG{__DIE__} = sub { return if $^S; print STDERR "tree script failed: @_"; exit 5 };

# An agent-chosen name goes into an error message escaped onto one printable line.
sub shown { my $p = shift; $p =~ s/([^\w.\/ -])/sprintf("\\x%02x", ord $1)/ge; return $p }
sub fail { my ($code, $message) = @_; print STDERR "$message\n"; exit $code }
# The manifest carries names as JSON text. Strict UTF-8 refuses surrogates and code points past U+10FFFF, which a lax
# decoder would pass and Node would turn into U+FFFD, so two different names could show as one. Control and format
# characters and line and paragraph separators (Unicode Cc, Cf, Zl, Zp: C0, DEL, C1, bidirectional marks and overrides,
# zero-width characters, the byte order mark) can make a name display as another, so they are refused too, as is a
# name longer than the manifest carries.
sub text {
  my ($bytes, $what) = @_;
  fail(8, "$what " . shown(substr($bytes, 0, 64)) . "... is longer than $MAXIMUM_NAME_BYTES bytes") if length $bytes > $MAXIMUM_NAME_BYTES;
  my $text = eval { Encode::decode("UTF-8", $bytes, Encode::FB_CROAK | Encode::LEAVE_SRC) };
  fail(8, "$what " . shown($bytes) . " is not printable UTF-8")
    if !defined $text || $text =~ /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/;
  return $text;
}
sub children {
  my $dir = shift;
  opendir(my $handle, $dir) or fail(6, "could not read directory " . shown($dir) . ": $!");
  my @names = grep { $_ ne "." && $_ ne ".." } readdir $handle; closedir $handle; return sort @names;
}
sub join_path { my ($dir, $name) = @_; return $dir eq "." || $dir eq "" ? $name : "$dir/$name" }
my $json = JSON::PP->new->utf8->canonical;
sub emit {
  my $output = $json->encode(shift);
  fail(9, "the result is larger than $MAXIMUM_OUTPUT bytes") if length $output > $MAXIMUM_OUTPUT;
  print $output; exit 0;
}

sub file_digest {
  my $path = shift;
  sysopen(my $handle, $path, O_RDONLY | O_NOFOLLOW) or fail(6, "could not read metadata " . shown($path) . ": $!");
  binmode $handle; my $sha = Digest::SHA->new(256); $sha->addfile($handle); close $handle; return $sha->hexdigest;
}
# Paths are hashed relative to the root, so the seeder (at /metadata) and an inspection (at /work/.git) agree.
sub metadata_digest {
  my $root = shift; my $sha = Digest::SHA->new(256); my @pending = (".");
  while (@pending) {
    my $path = shift @pending; my $full = $path eq "." ? $root : "$root/$path";
    my @stat = lstat $full; fail(6, "could not stat metadata " . shown($path) . ": $!") unless @stat;
    my ($link, $directory, $file) = (-l _, -d _, -f _);
    # Object files are content-addressed and make up most of the volume; hashing them would slow every allocation.
    my $content = $link ? readlink $full : $file && $path !~ m{^objects/} ? file_digest($full) : "";
    $sha->add(join("\0", $path, @stat[1, 2, 4, 5, 7, 10, 9], $content), "\0");
    unshift @pending, map { join_path($path, $_) } children($full) if $directory;
  }
  return $sha->hexdigest;
}
if ($mode eq "digest") { print metadata_digest(shift @ARGV), "\n"; exit 0 }

chdir "/work" or fail(6, "could not enter the work tree: $!");
my %keep = map { $_ => 1 } qw(GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL GIT_OPTIONAL_LOCKS GIT_TERMINAL_PROMPT GIT_NO_LAZY_FETCH
  GIT_LITERAL_PATHSPECS);
delete $ENV{$_} for grep { /^GIT_/ && !$keep{$_} } keys %ENV;
# Paths are always literal: a name like ":/x" or ":(glob)x" is only a name.
@ENV{qw(HOME GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL GIT_OPTIONAL_LOCKS GIT_TERMINAL_PROMPT GIT_NO_LAZY_FETCH GIT_LITERAL_PATHSPECS)} =
  ("/tmp", "1", "/dev/null", "0", "0", "1", "1");
# Git reads only trusted repository config. Hooks, fsmonitor and the attributes and excludes files are off, the stat
# checks are pinned to their strict defaults, and a safecrlf warning cannot stop a hash.
my @GIT = ("git", "--no-pager", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
  "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "core.ignorecase=false",
  "-c", "core.trustctime=true", "-c", "core.checkStat=default", "-c", "core.filemode=true", "-c", "core.symlinks=true",
  "-c", "core.ignoreStat=false", "-c", "core.safecrlf=false", "-c", "core.untrackedCache=false");
sub exit_reason { my $status = shift; return $status == -1 ? "could not start" : ($status & 127) ? "killed by signal " . ($status & 127) : "status " . ($status >> 8) }
# Run Git in the work tree, optionally feeding it a file, and return its standard output. With $strict, anything Git
# writes to stderr fails the run: an error it reports but survives (an encoding it could not apply) means an answer
# that is not what a commit would store.
my $stderr_file = "/tmp/git-stderr";
sub git_in {
  my ($input, $strict, @args) = @_;
  my $pid = open(my $out, "-|"); fail(4, "could not run git: $!") unless defined $pid;
  if (!$pid) {
    if (defined $input) { open(STDIN, "<", $input) or die "could not open git input: $!" }
    if ($strict) { open(STDERR, ">", $stderr_file) or die "could not capture git errors: $!" }
    exec(@GIT, "-c", "core.worktree=/work", @args) or die "could not run git: $!";
  }
  local $/; my $output = <$out> // ""; close $out;
  my $errors = "";
  if ($strict && open(my $captured, "<", $stderr_file)) { $errors = <$captured> // ""; close $captured }
  my ($first) = split /\n/, $errors;
  # Name the Git command itself, past any "-c name=value" pairs in front of it.
  my @rest = @args; splice @rest, 0, 2 while @rest && $rest[0] eq "-c";
  # Git's line can quote an agent-chosen name: it stays one line of printable ASCII.
  (my $line = substr($first // "", 0, 300)) =~ s/([^\x20-\x7e])/sprintf("\\x%02x", ord $1)/ge;
  fail(4, "git $rest[0] failed (" . exit_reason($?) . ")" . ($line ne "" ? ": $line" : "")) if $? || $errors ne "";
  return $output;
}
sub git { return git_in(undef, 0, @_) }

my $format = git("rev-parse", "--show-object-format"); chomp $format;
my $algorithm = $format eq "sha256" ? 256 : 1;
# A Git blob ID over the bytes as they are: a link's stored content, or a file's identity in a target snapshot.
sub blob_id { my $bytes = shift; my $sha = Digest::SHA->new($algorithm); $sha->add("blob " . length($bytes) . "\0", $bytes); return $sha->hexdigest }
sub file_id {
  my $path = shift;
  sysopen(my $handle, $path, O_RDONLY | O_NOFOLLOW) or fail(6, "could not read " . shown($path) . ": $!");
  binmode $handle; my $size = -s $handle; my $sha = Digest::SHA->new($algorithm);
  $sha->add("blob $size\0"); $sha->addfile($handle); close $handle; return $sha->hexdigest;
}
# One entry as lstat sees it. Git modes for what Git can store; other types carry none.
sub entry {
  my $path = shift; my @stat = lstat $path; return undef unless @stat;
  my %entry = (ino => $stat[1], mode => sprintf("%o", $stat[2]), size => $stat[7], ctime => "$stat[10]", mtime => "$stat[9]");
  if (-l _) { my $target = readlink $path; @entry{qw(type gitMode oid linkTarget)} = ("symlink", "120000", blob_id($target), text($target, "the link target of " . shown($path))) }
  elsif (-f _) { @entry{qw(type gitMode)} = ("file", ($stat[2] & 0100) ? "100755" : "100644") }
  elsif (-d _) { $entry{type} = "directory" }
  else { $entry{type} = "other" }
  return \%entry;
}
sub under_git_path { return scalar grep { lc $_ eq ".git" } split m{/}, shift }
# What the walk keeps of each entry: its type and Git mode, and a link's content. A large checkout holds many.
sub walk_entry {
  my $path = shift; my @stat = lstat $path; return undef unless @stat;
  if (-l _) { my $target = readlink $path; return { type => "symlink", gitMode => "120000", oid => blob_id($target), linkTarget => text($target, "the link target of " . shown($path)) } }
  # Every file is hashed below; one that cannot be read fails the run here, with its name, rather than inside Git.
  if (-f _) { fail(6, "could not read " . shown($path) . ": permission denied") unless -r _; return { type => "file", gitMode => ($stat[2] & 0100) ? "100755" : "100644" } }
  return { type => "directory" } if -d _;
  # Git opens every .gitattributes it meets while hashing; a fifo or device there would block it until the deadline.
  my @parts = split m{/}, $path;
  fail(6, "the attributes file " . shown($path) . " is not a regular file") if $parts[-1] eq ".gitattributes";
  return { type => "other" };
}
# A target entry also carries the file's raw content ID: the snapshot compares identity, not what Git would store.
sub target_entry { my $path = shift; my $entry = entry($path); $entry->{oid} = file_id($path) if $entry->{type} eq "file"; return { path => text($path, "path"), %$entry } }

# Resolve a declared link as the kernel does in an agent container, where the work tree is /work, one part at a time.
# A part that is a link, before ".." or as the last part, stops it (through-link): a write would go on to wherever that
# link points. A missing part, or one that is not a directory, leaves it dangling (absent), anchored on the nearest
# existing entry. Only a target reached through real directories is watched. The path is tracked from the filesystem
# root, so "/work/x" and "../work/x" are inside; anywhere else outside /work is outside.
my $target_entries = 0;
# The anchor is the deepest entry on the way to the given path reached through real directories only: walking down one
# part at a time, it stops at the first part that is missing, a link or not a directory. It never reads through a link.
sub anchored {
  my ($status, $path) = @_; my $anchor = ""; my $prefix = "";
  for my $part (split m{/}, $path) {
    $prefix = join_path($prefix, $part); my @stat = lstat $prefix;
    last unless @stat;
    $anchor = $prefix;
    last if -l _ || !-d _;
  }
  return { status => $status, anchor => target_entry($anchor eq "" ? "." : $anchor) };
}
sub resolve {
  my ($link, $walk) = @_; my %record = (link => text($link, "declared path"));
  my @parents = split m{/}, $link; pop @parents; my $prefix = "";
  for my $part (@parents) {
    my $parent = $prefix; $prefix = join_path($prefix, $part); my @stat = lstat $prefix;
    return { %record, %{ anchored("absent", $parent) } } unless @stat;
    return { %record, %{ anchored("through-link", $prefix) } } if -l _;
    return { %record, %{ anchored("absent", $prefix) } } unless -d _;
  }
  my @stat = lstat $link;
  return { %record, status => "not-a-link" } unless @stat && -l _;
  my $raw = readlink $link; $record{linkTarget} = text($raw, "the link target of " . shown($link));
  # From the filesystem root: ("work", ...) is inside the work tree.
  my @at = $raw =~ m{^/} ? () : ("work", @parents);
  my @parts = grep { $_ ne "" && $_ ne "." } split m{/}, $raw;
  # Once a directory on the way is missing, the rest is followed by name: that is where the link leads if the missing
  # directories are created as directories, so the target stays the same whether they exist or not. A ".." after a
  # missing part cannot be followed by name (what it climbs back into is not known), so that link is absent with no
  # target.
  my $missing = 0;
  for my $i (0 .. $#parts) {
    if ($parts[$i] eq "..") {
      return { %record, %{ anchored("absent", join "/", @at[1 .. $#at]) } } if $missing;
      pop @at; next;
    }
    push @at, $parts[$i];
    return { %record, status => "outside" } if $at[0] ne "work";
    return { %record, status => "metadata" } if @at > 1 && $at[1] eq ".git";
    next if @at == 1 || $missing;
    my $path = join "/", @at[1 .. $#at]; my @here = lstat $path;
    if (!@here) { $missing = 1; next }
    return { %record, %{ anchored("through-link", $path) } } if -l _;
    return { %record, %{ anchored("absent", $path) } } if $i < $#parts && !-d _;
  }
  return { %record, status => "outside" } if @at < 2;
  my $target = join "/", @at[1 .. $#at];
  # A dangling target, watched like any other: creating it, or what leads to it, is a change to it.
  return { %record, target => text($target, "path"), %{ anchored("absent", $target) } } if $missing;
  my @final = lstat $target;
  return { %record, target => text($target, "path"), %{ $walk ? target_state($target) : { status => @final ? "present" : "absent" } } };
}
# The state of a target: absent, present with every entry beneath it walked without following links, or through-link
# when a part on the way is a link (the agent may have made one since the snapshot) or a link inside a directory target
# leads elsewhere. Its parents are checked one part at a time, so nothing outside the work tree is ever read.
sub target_state {
  my $target = shift; my @parents = split m{/}, $target; pop @parents; my $prefix = "";
  for my $part (@parents) {
    $prefix = join_path($prefix, $part); my @stat = lstat $prefix;
    return anchored("absent", $target) unless @stat;
    return anchored("through-link", $target) if -l _;
    return anchored("absent", $target) unless -d _;
  }
  my @stat = lstat $target;
  return anchored("absent", $target) unless @stat;
  my @entries; my @pending = ($target);
  while (@pending) {
    my $path = shift @pending;
    fail(9, "declared link targets hold more than $MAXIMUM_TARGET_ENTRIES entries") if ++$target_entries > $MAXIMUM_TARGET_ENTRIES;
    my $entry = target_entry($path); push @entries, $entry;
    unshift @pending, map { "$path/$_" } children($path) if $entry->{type} eq "directory";
  }
  # Every entry is recorded and compared either way; a link inside means a write can land outside the target.
  my ($link) = grep { $_->{type} eq "symlink" } @entries;
  return $link ? { status => "through-link", anchor => $link, entries => \@entries } : { status => "present", entries => \@entries };
}

if ($mode eq "snapshot") { emit({ links => [map { resolve($_, 1) } @ARGV] }) }

fail(2, "unknown mode") unless $mode eq "inspect";
my $base = shift @ARGV;
fail(3, "base is not a full commit ID") unless $base =~ /^[0-9a-f]{40}([0-9a-f]{24})?$/;
my $exists = system(@GIT, "cat-file", "-e", "$base^{commit}");
fail(4, "git cat-file failed (" . exit_reason($?) . ")") if $? == -1 || ($? & 127);
fail(3, "base $base is not a commit in this task storage") if $exists != 0;
my $link_count = shift @ARGV;
fail(2, "bad link count") unless defined $link_count && $link_count =~ /^\d+$/ && $link_count <= @ARGV;
my @links = splice @ARGV, 0, $link_count; my @targets = @ARGV;

# The tree of base: every blob and gitlink, and every directory above one. Its .gitignore files are the only ignore
# rules that count, with the repository's info/exclude: the agent's own edits to them do not decide what is listed.
my (%base, %base_directory);
mkdir "/tmp/ignore" or fail(4, "could not create the ignore tree: $!");
for my $record (split /\0/, git("ls-tree", "-r", "-z", "--full-tree", $base)) {
  my ($meta, $path) = split /\t/, $record, 2; my ($git_mode, $kind, $oid) = split / /, $meta;
  text($path, "path");
  $base{$path} = { gitMode => $git_mode, oid => $oid,
    type => $git_mode eq "160000" ? "gitlink" : $git_mode eq "120000" ? "symlink" : "file" };
  my @parts = split m{/}, $path; my $name = pop @parts;
  $base_directory{join "/", @parts[0 .. $_]} = 1 for 0 .. $#parts;
  if ($name eq ".gitignore" && $git_mode =~ /^100/) {
    my $dir = "/tmp/ignore"; for my $part (@parts) { $dir .= "/$part"; mkdir $dir unless -d $dir }
    open(my $file, ">", "$dir/.gitignore") or fail(4, "could not write the ignore tree: $!");
    binmode $file; print $file git("cat-file", "blob", $oid); close $file or fail(4, "could not write the ignore tree: $!");
  }
}

# One check-ignore process answers for each new entry as the walk reaches it, so an ignored directory is never entered.
# It prints a record for every path (--non-matching --verbose); a path is ignored when the last matching pattern is not
# a negation. check-ignore refuses literal pathspecs, so each path goes in behind "./" instead: Git reads pathspec
# magic only at the start of a path, so ":/x" or ":(glob)x" is then only a name.
my ($ignore_out, $ignore_in);
my $ignore_pid = do {
  local $ENV{GIT_DIR} = "/work/.git"; local $ENV{GIT_LITERAL_PATHSPECS}; delete $ENV{GIT_LITERAL_PATHSPECS};
  eval { open2($ignore_out, $ignore_in, @GIT, "-C", "/tmp/ignore", "--work-tree=/tmp/ignore", "check-ignore", "--no-index",
    "--stdin", "-z", "--non-matching", "--verbose") } // fail(4, "could not run git check-ignore: $@");
};
# check-ignore decides whether a directory-only pattern (such as "build/") applies by looking at the path in /tmp/ignore,
# so that tree mirrors what each checked path is: a new directory is created there first, and a directory in the way of
# a file (one where base tracked a .gitignore) is moved aside. A path goes in without a trailing slash: with one, a
# pattern such as "build/*" would match the directory itself and hide what a negation re-includes.
my $aside = 0;
sub move_aside {
  my $path = shift; mkdir "/tmp/aside" unless -d "/tmp/aside";
  rename $path, "/tmp/aside/" . $aside++ or fail(4, "could not move a mirrored entry aside: $!");
}
sub is_ignored {
  my ($path, $directory) = @_; my $mirror = "/tmp/ignore";
  my @parts = split m{/}, $path; my $name = pop @parts;
  # Every parent is a directory in the work tree (the walk is inside it), so it is made one in the mirror too. The mirror
  # holds only directories and base's .gitignore files, and a rule file is never moved: where one stands in the way (the
  # agent made a directory named .gitignore), nothing deeper is mirrored. Git then sees no directory there, so a
  # directory-only pattern does not match below it: that can only list more, never hide anything.
  for my $part (@parts, $directory ? ($name) : ()) {
    $mirror .= "/$part";
    last if -e $mirror && !-d $mirror;
    next if -d $mirror;
    mkdir $mirror or fail(4, "could not mirror a directory: $!");
  }
  # A directory in the way of a file (base tracked build/.gitignore, the agent made build a file) would let a
  # directory-only pattern match the file, so it goes. The rule files inside it only govern paths under it, and there
  # are none now.
  if (!$directory) { my $at = "/tmp/ignore/$path"; move_aside($at) if -d $at }
  print $ignore_in "./$path\0"; $ignore_in->flush;
  local $/ = "\0"; my @fields;
  for (1 .. 4) { my $field = <$ignore_out>; fail(4, "git check-ignore stopped answering") unless defined $field; chomp $field; push @fields, $field }
  return $fields[2] ne "" && $fields[2] !~ /^!/;
}

# The work tree, walked without following links. The top-level .git is the metadata mount, read separately. A gitlink
# directory is not entered: anything in it, or a gitlink directory it cannot read, is nested content. A new ignored
# directory with no tracked entry beneath it is reported once and not entered. Every new entry that is not a directory
# becomes a change (an add or half of a rename), so past MAXIMUM_CHANGES of them the answer is already too large.
my (%work, @nested, %has_child, %ignored, %collapsed);
my $new_entries = 0;
my @pending = grep { $_ ne ".git" } children(".");
while (@pending) {
  my $path = shift @pending; text($path, "path");
  my $entry = walk_entry($path) // fail(6, "could not stat " . shown($path) . ": $!");
  $work{$path} = $entry;
  my @parts = split m{/}, $path; pop @parts; $has_child{join "/", @parts} = 1 if @parts;
  my $directory = $entry->{type} eq "directory";
  if (!$base{$path}) {
    $ignored{$path} = 1 if is_ignored($path, $directory);
    if ($directory && $ignored{$path} && !$base_directory{$path}) { $collapsed{$path} = 1; next }
    fail(9, "more than $MAXIMUM_CHANGES new entries; the change set is too large to inspect")
      if !$directory && ++$new_entries > $MAXIMUM_CHANGES;
  }
  next unless $directory;
  if ((($base{$path} // {})->{type} // "") eq "gitlink") {
    my $ok = opendir(my $handle, $path); my @inside = $ok ? grep { $_ ne "." && $_ ne ".." } readdir $handle : ();
    push @nested, $path if !$ok || @inside; next;
  }
  unshift @pending, map { "$path/$_" } children($path);
}
close $ignore_in; waitpid($ignore_pid, 0);
fail(4, "git check-ignore failed (status " . ($? >> 8) . ")") if ($? >> 8) > 1 || ($? & 127);

# Git blob IDs for what would be committed: every tracked and new file, hashed as git add would store it. Every file is
# read: a file's times do not always move when its content does (not every way of writing to tmpfs updates them), so an
# unchanged stat proves nothing. They are hashed into a scratch index built from base, as the seeded index is, with
# --info-only so no object is written: Git then applies the work tree's attributes exactly as git add does, including
# leaving a text=auto file's CRLF alone when base already stores it that way.
my @commitable = grep { $work{$_}{type} eq "file" && !under_git_path($_) } sort keys %work;
if (@commitable) {
  local $ENV{GIT_INDEX_FILE} = "/tmp/scratch-index";
  git("read-tree", $base);
  open(my $list, ">", "/tmp/hash-paths") or fail(4, "could not write the paths to hash: $!");
  print $list map { "$_\0" } @commitable; close $list or fail(4, "could not write the paths to hash: $!");
  # A path that replaces a base file or directory (docs becoming docs/api/x) replaces its entries.
  git_in("/tmp/hash-paths", 1, "-c", "core.protectNTFS=false", "-c", "core.protectHFS=false",
    "update-index", "--add", "--replace", "--info-only", "-z", "--stdin");
  my %wanted = map { $_ => 1 } @commitable;
  for my $record (split /\0/, git("ls-files", "-s", "-z")) {
    my ($meta, $path) = split /\t/, $record, 2; next unless $wanted{$path};
    $work{$path}{oid} = (split / /, $meta)[1];
  }
  defined $work{$_}{oid} or fail(4, "git did not hash " . shown($_)) for @commitable;
}
# A file under a .git part can never be committed; its ID is its bytes, for the record.
$work{$_}{oid} = file_id($_) for grep { $work{$_}{type} eq "file" && under_git_path($_) } keys %work;

sub under_git { return under_git_path(shift) ? JSON::PP::true : JSON::PP::false }
my (@changes, @deleted, @added);
sub change {
  my ($kind, $path, $old, $new, $ignored) = @_;
  my %change = (kind => $kind, path => $path, underGit => under_git($path), ignored => $ignored ? JSON::PP::true : JSON::PP::false);
  if ($old) { @change{qw(oldType oldMode oldOid)} = @$old{qw(type gitMode oid)} }
  if ($new) { @change{qw(newType newMode newOid newLinkTarget)} = @$new{qw(type gitMode oid linkTarget)} }
  delete $change{$_} for grep { !defined $change{$_} } keys %change;
  return \%change;
}
for my $path (sort keys %base) {
  my ($old, $new) = ($base{$path}, $work{$path});
  if (!$new) { push @deleted, change("delete", $path, $old); next }
  if ($old->{type} eq "gitlink") { push @changes, change("modify", $path, $old, $new) if $new->{type} ne "directory"; next }
  if ($new->{type} ne $old->{type}) { push @changes, change("modify", $path, $old, $new); next }
  my ($content, $mode) = ($new->{oid} ne $old->{oid}, $new->{gitMode} ne $old->{gitMode});
  push @changes, change($content ? "modify" : "mode", $path, $old, $new) if $content || $mode;
}
for my $path (sort keys %work) {
  next if $base{$path}; my $new = $work{$path};
  if ($collapsed{$path}) { push @changes, change("add", $path, undef, { type => "directory" }, 1); next }
  # A directory is a change only when it is new and empty: otherwise what is in it is listed.
  next if $new->{type} eq "directory" && ($base_directory{$path} || $has_child{$path});
  push @added, change("add", $path, undef, $new, $ignored{$path});
}
# An exact rename: a deleted and an added entry of the same type with the same stored content, paired in path order.
my %by_content;
push @{ $by_content{"$_->{newType}:$_->{newOid}"} }, $_ for grep { defined $_->{newOid} } @added;
my (%paired_add, %paired_delete);
for my $gone (@deleted) {
  my $match = shift @{ $by_content{"$gone->{oldType}:" . ($gone->{oldOid} // "")} // [] } or next;
  $paired_add{$match->{path}} = 1; $paired_delete{$gone->{path}} = 1;
  my %rename = (%$match, kind => "rename", oldPath => $gone->{path});
  @rename{qw(oldType oldMode oldOid)} = @$gone{qw(oldType oldMode oldOid)};
  push @changes, \%rename;
}
push @changes, grep { !$paired_delete{$_->{path}} } @deleted;
push @changes, grep { !$paired_add{$_->{path}} } @added;
fail(9, "more than $MAXIMUM_CHANGES changes; the change set is too large to inspect") if @changes > $MAXIMUM_CHANGES;
@changes = sort { $a->{path} cmp $b->{path} } @changes;
for my $change (@changes) {
  $change->{path} = text($change->{path}, "path");
  $change->{oldPath} = text($change->{oldPath}, "path") if defined $change->{oldPath};
}

my $head = git("rev-parse", "--verify", "HEAD"); chomp $head;
my @agent_commits;
if ($head ne $base) {
  @agent_commits = split /\n/, git("rev-list", "--max-count=100", $head, "--not", $base);
  @agent_commits = ($head) unless @agent_commits;
}
my @fresh = map { resolve($_, 0) } @links;
my %targets = map { (text($_, "target") => target_state($_)) } @targets;
emit({ metadataDigest => metadata_digest("/work/.git"), head => $head, agentCommits => \@agent_commits,
  changes => \@changes, nestedGitlinkContent => [map { text($_, "path") } sort @nested], links => \@fresh, targets => \%targets });
`;
