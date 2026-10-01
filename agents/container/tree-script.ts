/**
 * The Perl program D runs inside task storage to read it without following links (#66). One program serves five modes,
 * so the seeder's checks and a later inspection read storage the same way:
 *
 * - `links <work> <metadata>` (run by the seeder, as root, over what it copied) refuses, with exit 11, any link in the
 *   metadata and any work-tree link that can lead out of the work tree, resolved as the container's kernel would.
 *
 * - `digest <root>` prints one SHA-256 over every entry under `root`: its path, inode, mode, owner, size, ctime, mtime,
 *   link target and every regular file's content. Content is hashed rather than trusted to the times, which a write
 *   does not always move.
 * - `snapshot <baseline> <link>...` (in /work) resolves each declared link as the kernel would in an agent container,
 *   one part at a time, and records the state of its target and everything beneath it.
 * - `inspect <baseline> <base> <link count> <link>... <target>...` (in /work) compares the work tree with the tree of
 *   `base`, hashing every file as a commit would store it, resolves each declared link again (without walking its
 *   target), and reports the state now of each target the snapshot recorded, the metadata digest and HEAD.
 * - `commit <baseline> <base> <bundle limit> <link count> <link>... <target>...` (in /work) runs the inspection, then,
 *   from the same reads, builds the runner commit on top of `base` from base plus the changes it found. It reads the
 *   message and identities as JSON on stdin and writes every object to a scratch object store in /tmp: both volumes
 *   stay read-only. It prints the inspection's JSON on one line, encoded before the commit is built, then the commit's
 *   tree and ID as JSON on the next, then the commit as a base64 `git bundle` of at most `bundle limit` bytes. It
 *   builds nothing when there is nothing to commit, when HEAD is not `base`, a gitlink has content, or a change is one
 *   a commit cannot hold (a directory, a fifo or other special file, a path under a `.git` part, or a symlink named
 *   `.gitmodules`); the runner refuses those.
 *
 * Snapshot, inspect and commit first compare the metadata digest with `baseline`, before any Git command: if it differs, a snapshot refuses
 * (exit 10) and an inspection prints only the digest and `metadataOnly`.
 *
 * Output is one JSON document on stdout, at most MAXIMUM_TREE_OUTPUT bytes (a commit adds its own line and the bundle). A reported path or link target that is not
 * strict UTF-8, holds a control, format, separator or unassigned character, or is over MAXIMUM_NAME_BYTES cannot be
 * put in the manifest (exit 8); an unchanged one is never checked. More than MAXIMUM_CHANGES changes, more than
 * MAXIMUM_TARGET_ENTRIES target entries, or more output than the bound cannot be returned whole (exit 9). A directory
 * or file it cannot read fails it (exit 6), since what is inside is unknown. Exit 3 is a bad base, exit 4 a Git failure,
 * exit 2 a bad argument, exit 5 an unexpected failure of the script itself. None of these returns part of the answer: a
 * commit may have printed some of its output first, but the runner discards all of it when the exit status is not 0.
 */
export const MAXIMUM_CHANGES = 10_000;
/** Entries recorded beneath all declared links' targets together, in one snapshot or inspection. */
export const MAXIMUM_TARGET_ENTRIES = 20_000;
/** Declared links in one snapshot or inspection. */
export const MAXIMUM_DECLARED_LINKS = 200;
/** Bytes in one path or link target the manifest carries; a longer one fails the run (exit 8). */
export const MAXIMUM_NAME_BYTES = 1_024;
/** The one ref a runner commit's bundle carries, pointing at the commit. */
export const TASK_COMMIT_REF = 'refs/heads/codeboost';
// JSON at most doubles a name (a quote or backslash is escaped; control characters are refused). A change carries at
// most three names (a populated gitlink, which counts as a change, one), a target entry or a link record at most five,
// each with under 1 KiB of other fields.
const KIB = 1024;
/** The largest output the limits above allow; the script also refuses to print more. */
export const MAXIMUM_TREE_OUTPUT = MAXIMUM_CHANGES * (3 * 2 * MAXIMUM_NAME_BYTES + KIB)
  + MAXIMUM_TARGET_ENTRIES * (5 * 2 * MAXIMUM_NAME_BYTES + KIB) + 2 * MAXIMUM_DECLARED_LINKS * (5 * 2 * MAXIMUM_NAME_BYTES + KIB)
  + 64 * KIB;

export const TREE_SCRIPT = String.raw`
use strict; use warnings;
use Time::HiRes qw(lstat); use Digest::SHA; use JSON::PP; use Encode (); use Fcntl qw(O_RDONLY O_NOFOLLOW);
use IPC::Open2 qw(open2); use MIME::Base64 ();
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
# name longer than the manifest carries. So is a code point this Perl's Unicode does not assign (Cn): a format
# character added in a later Unicode version is one this check cannot recognise.
sub text {
  my ($bytes, $what) = @_;
  fail(8, "$what " . shown(substr($bytes, 0, 64)) . "... is longer than $MAXIMUM_NAME_BYTES bytes") if length $bytes > $MAXIMUM_NAME_BYTES;
  my $text = eval { Encode::decode("UTF-8", $bytes, Encode::FB_CROAK | Encode::LEAVE_SRC) };
  fail(8, "$what " . shown($bytes) . " is not a name the manifest can carry (strict UTF-8 with no control, format,"
    . " separator or unassigned character)")
    if !defined $text || $text =~ /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cn}]/;
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
    # Every file's content, objects and packs included: a name that says what the content is proves nothing if the
    # bytes can change without moving the times.
    my $content = $link ? readlink $full : $file ? file_digest($full) : "";
    $sha->add(join("\0", $path, @stat[1, 2, 4, 5, 7, 10, 9], $content), "\0");
    unshift @pending, map { join_path($path, $_) } children($full) if $directory;
  }
  return $sha->hexdigest;
}
if ($mode eq "digest") { print metadata_digest(shift @ARGV), "\n"; exit 0 }

# Whether a link in the work tree can lead out of it, resolved as the kernel does in an agent container, where the work
# tree is /work: by bytes, with exact names, following every link on the way. A part that is missing, or is a file
# with more after it, is taken as a directory the agent may create: what follows is resolved by name until a ".."
# climbs back above it, where real parts are checked again. An absolute target counts as leaving; a cycle the kernel
# gives up on (40 links) reaches nothing.
sub link_escapes {
  my ($root, $link) = @_;
  my @at = split m{/}, $link; pop @at;
  my $text = readlink "$root/$link"; return 1 if $text =~ m{^/};
  my @todo = split m{/}, $text; my ($hops, $virtual) = (0, 0);
  while (@todo) {
    my $part = shift @todo; next if $part eq "" || $part eq ".";
    if ($part eq "..") { return 1 unless @at; pop @at; $virtual-- if $virtual; next }
    push @at, $part;
    if ($virtual) { $virtual++; next }
    my $path = "$root/" . join("/", @at); my @stat = lstat $path;
    if (!@stat) { $virtual = 1; next }
    if (-l _) {
      return 0 if ++$hops > 40;
      my $target = readlink $path; return 1 if $target =~ m{^/};
      pop @at; unshift @todo, split m{/}, $target; next;
    }
    $virtual = 1 if !-d _ && @todo;
  }
  return 0;
}
# Run by the seeder over what it copied, before anything else can use it: no link in the metadata at all (Git never
# needs one, and it is mounted at /work/.git), and none in the work tree that can lead out of it.
if ($mode eq "links") {
  my ($work, $metadata) = @ARGV;
  my @pending = (".");
  while (@pending) {
    my $path = shift @pending; my $full = $path eq "." ? $metadata : "$metadata/$path";
    my @stat = lstat $full; fail(6, "could not stat metadata " . shown($path) . ": $!") unless @stat;
    fail(11, "Repository Git metadata contains a link: " . shown($path)) if -l _;
    unshift @pending, map { join_path($path, $_) } children($full) if -d _;
  }
  @pending = grep { $_ ne ".git" } children($work);
  while (@pending) {
    my $path = shift @pending; my @stat = lstat "$work/$path"; fail(6, "could not stat " . shown($path) . ": $!") unless @stat;
    if (-l _) { fail(11, "Repository link leaves the checkout: " . shown($path)) if link_escapes($work, $path); next }
    unshift @pending, map { "$path/$_" } children("$work/$path") if -d _;
  }
  exit 0;
}

chdir "/work" or fail(6, "could not enter the work tree: $!");
# Before any Git command, the metadata must be as the seeder left it: Git reads its config, and config the agent could
# have changed must never run (a filter driver, say). If it changed, no Git runs at all: a snapshot refuses, and an
# inspection or a commit reports only that.
my $baseline = shift @ARGV // "";
fail(2, "bad metadata baseline") unless $baseline =~ /^[0-9a-f]{64}\z/;
my $metadata_digest = metadata_digest("/work/.git");
if ($metadata_digest ne $baseline) {
  fail(10, "the metadata changed since the storage was seeded; no Git command was run") if $mode eq "snapshot";
  emit({ metadataDigest => $metadata_digest, metadataOnly => JSON::PP::true });
}
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
# Run Git in the work tree, optionally feeding it a file, and return its standard output. With $strict, an error Git
# reports but survives (an encoding it could not apply) fails the run: the answer is not what a commit would store.
# A warning does not: Git has ignored something (a negative attribute pattern, a symlinked .gitattributes) exactly as a
# commit would, so the answer still holds. Nor do the two complaints Git prints without a prefix about an attribute line
# it skips ("<name> is not a valid attribute name: <file>:<line>", "<macro> not allowed: <file>:<line>"). Any other line
# fails it.
# The first line of Git's stderr that means it did less than asked, or undef. A warning can run over several lines; a
# line that follows one without a prefix of its own belongs to it.
sub stderr_failure {
  my $errors = shift; my ($first, $in_warning);
  for my $line (split /\n/, $errors) {
    if ($line =~ /^warning: /) { $in_warning = 1; next }
    if ($line =~ /^(?:error|fatal): /) { $first = $line; last }
    # The path can hold a colon, so everything after the fixed phrase is taken as the file.
    if ($line =~ /(?: is not a valid attribute name| not allowed): (?:.+\/)?\.gitattributes:\d+\z/) { $in_warning = 0; next }
    # Only the lines right after a warning continue it.
    if (!$in_warning) { $first = $line; last }
  }
  return $first;
}
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
  my $first = $strict ? stderr_failure($errors) : undef;
  # Name the Git command itself, past any "-c name=value" pairs in front of it.
  my @rest = @args; splice @rest, 0, 2 while @rest && $rest[0] eq "-c";
  # Git's line can quote an agent-chosen name: it stays one line of printable ASCII.
  (my $line = substr($first // "", 0, 300)) =~ s/([^\x20-\x7e])/sprintf("\\x%02x", ord $1)/ge;
  fail(4, "git $rest[0] " . ($? ? "failed (" . exit_reason($?) . ")" : "reported an error") . ($line ne "" ? ": $line" : ""))
    if $? || defined $first;
  return $output;
}
sub git { return git_in(undef, 0, @_) }
# Git in the mirror of base's attribute files (/tmp/attributes), strict like git_in: it reads base's rules, never the
# work tree's.
sub git_in_mirror {
  my ($input, @args) = @_;
  my $pid = open(my $out, "-|"); fail(4, "could not run git: $!") unless defined $pid;
  if (!$pid) {
    chdir "/tmp/attributes" or die "could not enter the attribute mirror: $!";
    $ENV{GIT_DIR} = "/work/.git";
    if (defined $input) { open(STDIN, "<", $input) or die "could not open git input: $!" }
    open(STDERR, ">", $stderr_file) or die "could not capture git errors: $!";
    exec(@GIT, "--work-tree=/tmp/attributes", @args) or die "could not run git: $!";
  }
  local $/; my $output = <$out> // ""; close $out;
  my $errors = ""; if (open(my $captured, "<", $stderr_file)) { $errors = <$captured> // ""; close $captured }
  my $first = stderr_failure($errors);
  (my $line = substr($first // "", 0, 300)) =~ s/([^\x20-\x7e])/sprintf("\\x%02x", ord $1)/ge;
  fail(4, "git $args[0] " . ($? ? "failed (" . exit_reason($?) . ")" : "reported an error") . ($line ne "" ? ": $line" : ""))
    if $? || defined $first;
  return $output;
}

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
  # The link target is checked as a name only if it is reported, like the path itself.
  if (-l _) { my $target = readlink $path; return { type => "symlink", gitMode => "120000", oid => blob_id($target), linkTarget => $target } }
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
# existing entry. A target is watched when every existing part on the way is a real directory (past a missing one, by
# name; see below). The path is tracked from the filesystem
# root, so "/work/x" and "../work/x" are inside; anywhere else outside /work is outside.
my $target_entries = 0; my %resolved_targets;
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
# With $unchecked, names are kept as bytes and never checked: only the status is wanted.
sub resolve {
  my ($link, $walk, $unchecked) = @_; my $name = $unchecked ? sub { $_[0] } : \&text;
  my %record = (link => $name->($link, "declared path"));
  my @parents = split m{/}, $link; pop @parents; my $prefix = "";
  # A declared path that is not there, or not a link, is not-a-link whether or not its directory exists: adding or
  # deleting a declared file must not look like a change to a link. A directory on the way that is a link still makes
  # it through-link, since anything written there lands elsewhere.
  for my $part (@parents) {
    $prefix = join_path($prefix, $part); my @stat = lstat $prefix;
    return { %record, status => "not-a-link" } unless @stat;
    return { %record, %{ anchored("through-link", $prefix) } } if -l _;
    return { %record, status => "not-a-link" } unless -d _;
  }
  my @stat = lstat $link;
  return { %record, status => "not-a-link" } unless @stat && -l _;
  my $raw = readlink $link; $record{linkTarget} = $name->($raw, "the link target of " . shown($link));
  # From the filesystem root: ("work", ...) is inside the work tree.
  my @at = $raw =~ m{^/} ? () : ("work", @parents);
  my @parts = grep { $_ ne "" && $_ ne "." } split m{/}, $raw;
  # Past a part that is missing or not a directory the way is followed by name, ".." included: that is the only place
  # the link can ever lead (the part would have to become a directory), so the target is recorded and watched whether
  # it exists or not. Every part that does exist is still checked, even after a missing one: a ".." can climb back
  # into real directories, and a link met there makes it through-link.
  for my $i (0 .. $#parts) {
    if ($parts[$i] eq "..") { pop @at; next }
    push @at, $parts[$i];
    return { %record, status => "outside" } if $at[0] ne "work";
    return { %record, status => "metadata" } if @at > 1 && $at[1] eq ".git";
    next if @at == 1;
    my $path = join "/", @at[1 .. $#at]; my @here = lstat $path;
    return { %record, %{ anchored("through-link", $path) } } if @here && -l _;
  }
  return { %record, status => "outside" } if @at < 2;
  my $target = join "/", @at[1 .. $#at];
  # A dangling target, past a missing directory or not, is watched like any other: creating it, or what leads to it, is
  # a change to it. The target's own state (its entries, or its anchor) is reported once per target, not per link.
  my @final = lstat $target; $resolved_targets{$target} = 1;
  my $status = $walk ? target_state($target)->{status} : @final ? "present" : "absent";
  return { %record, target => $name->($target, "path"), status => $status };
}
# Each distinct target is walked once per run, so two declared links to one target count its entries once.
my %target_states;
sub target_state { my $target = shift; return $target_states{$target} //= walk_target($target) }
# The state of a target: absent, present with every entry beneath it walked without following links, or through-link
# when a part on the way is a link (the agent may have made one since the snapshot) or a link inside a directory target
# leads elsewhere. Its parents are checked one part at a time, so nothing outside the work tree is ever read.
sub walk_target {
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

# Each target's state once, keyed by path: two links to one target do not repeat its entries.
if ($mode eq "snapshot") {
  my @links = map { resolve($_, 1) } @ARGV;
  emit({ links => \@links, targets => { map { (text($_, "target") => target_state($_)) } keys %resolved_targets } });
}

fail(2, "unknown mode") unless $mode eq "inspect" || $mode eq "commit";
my $base = shift @ARGV;
fail(3, "base is not a full commit ID") unless $base =~ /^[0-9a-f]{40}([0-9a-f]{24})?$/;
my $bundle_limit = $mode eq "commit" ? shift @ARGV : 0;
fail(2, "bad bundle limit") unless $mode ne "commit" || (defined $bundle_limit && $bundle_limit =~ /^[1-9][0-9]{0,9}\z/);
# --verify -q exits 1, silently, for a name that is not a commit here; anything else is Git failing.
my $exists = do {
  my $pid = open(my $out, "-|", @GIT, "rev-parse", "--verify", "-q", "$base^{commit}") or fail(4, "could not run git: $!");
  local $/; my $ignored = <$out>; close $out; $?;
};
fail(4, "git rev-parse failed (" . exit_reason($?) . ")") if $? == -1 || ($? & 127) || ($? >> 8) > 1;
fail(3, "base $base is not a commit in this task storage") if $exists != 0;
my $link_count = shift @ARGV;
fail(2, "bad link count") unless defined $link_count && $link_count =~ /^\d+$/ && $link_count <= @ARGV;
my @links = splice @ARGV, 0, $link_count; my @targets = @ARGV;

# The tree of base: every blob and gitlink, and every directory above one. Its .gitignore files are the only ignore
# rules that count, with the repository's info/exclude: the agent's own edits to them do not decide what is listed.
my (%base, %base_directory);
mkdir "/tmp/ignore" or fail(4, "could not create the ignore tree: $!");
mkdir "/tmp/attributes" or fail(4, "could not create the attribute mirror: $!");
for my $record (split /\0/, git("ls-tree", "-r", "-z", "--full-tree", $base)) {
  my ($meta, $path) = split /\t/, $record, 2; my ($git_mode, $kind, $oid) = split / /, $meta;
  $base{$path} = { gitMode => $git_mode, oid => $oid,
    type => $git_mode eq "160000" ? "gitlink" : $git_mode eq "120000" ? "symlink" : "file" };
  my @parts = split m{/}, $path; my $name = pop @parts;
  $base_directory{join "/", @parts[0 .. $_]} = 1 for 0 .. $#parts;
  # Base's attribute files too: the checkout comparison below reads base's rules, as the clone's checkout did. The
  # checkout read a symlinked one from the index, as its target text, so that text is mirrored as a regular file.
  if ($name eq ".gitattributes" && $git_mode =~ /^(?:100|120)/) {
    my $dir = "/tmp/attributes"; for my $part (@parts) { $dir .= "/$part"; mkdir $dir unless -d $dir }
    open(my $file, ">", "$dir/.gitattributes") or fail(4, "could not write the attribute mirror: $!");
    binmode $file; print $file git("cat-file", "blob", $oid); close $file or fail(4, "could not write the attribute mirror: $!");
  }
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
  # holds only directories and base's .gitignore files, and a rule file is never moved. Where one stands in the way (the
  # agent made a directory named .gitignore), nothing deeper can be mirrored, so Git could not tell what is a directory
  # there and a directory-only pattern (a negation such as "!*/") would be misapplied. Such a path is taken as not
  # ignored, without asking: it is listed, never collapsed.
  for my $part (@parts, $directory ? ($name) : ()) {
    $mirror .= "/$part";
    return 0 if -e $mirror && !-d $mirror;
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
  my $path = shift @pending;
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

# Git blob IDs for what would be committed: every tracked and new file, hashed as git add stores a file. Every file is
# read: a file's times do not always move when its content does (not every way of writing to tmpfs updates them), so an
# unchanged stat proves nothing. They are hashed into a scratch index built from base, as the seeded index is, with
# --info-only so no object is written: Git applies the work tree's attributes as git add does, including leaving a
# text=auto file's CRLF alone when base already stores it that way. The scratch index only computes these IDs. The
# commit step builds its tree from base plus the manifest's changes, storing each file as hashed here; what the
# manifest does not list (an unchanged submodule, a symlinked .gitattributes) stays as base has it.
my @commitable = grep { $work{$_}{type} eq "file" && !under_git_path($_) } sort keys %work;
# What is gone, or is no longer the same type, leaves the scratch index first: Git reads a deleted .gitattributes from
# the index, and nothing may be hashed with rules the work tree no longer has. (git add -A is not consistent here: it
# applies a deleted .gitattributes to paths it reaches before the deletion, so its result depends on path order.)
# Every .gitattributes leaves it too, a symlink included: where Git will not read the work tree's own (a symlink, one
# over 100 MB) it falls back to the index and parses what is there as rules, even a symlink's target text. So only
# attribute files the work tree has, and Git reads, decide; a regular one is added back below like any file.
my @gone = grep { !$work{$_} || $work{$_}{type} ne $base{$_}{type} || m{(?:\A|/)\.gitattributes\z} } sort keys %base;
# The index files are hashed against: base, without what is gone. The caller sets GIT_INDEX_FILE.
sub hashing_index {
  git("read-tree", $base);
  return unless @gone;
  open(my $removals, ">", "/tmp/removed-paths") or fail(4, "could not write the removed paths: $!");
  print $removals map { "$_\0" } @gone; close $removals or fail(4, "could not write the removed paths: $!");
  git_in("/tmp/removed-paths", 1, "update-index", "--force-remove", "-z", "--stdin");
}
if (@commitable) {
  local $ENV{GIT_INDEX_FILE} = "/tmp/scratch-index";
  hashing_index();
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

# A tracked file whose bytes are exactly what checking out base's blob writes is untouched, whatever re-hashing it would
# give: base can store a file Git would now store differently (committed with CRLF before a text rule, or an expanded
# $Id$ before an ident rule), or the agent can add a rule that would store an untouched file differently. A file whose
# bytes are base's blob is untouched. Otherwise both steps read base's attribute files, mirrored in /tmp/attributes,
# never the work tree's: check-attr picks the files whose checkout converts (with the repository's line-ending
# config), and cat-file --filters writes base's blob for each as the clone's checkout did.
my %as_checked_out;
{
  my @differ = grep { $work{$_} && $work{$_}{type} eq "file" && $base{$_}{type} eq "file" && $work{$_}{oid} ne $base{$_}{oid} }
    sort keys %base;
  my %converts;
  if (@differ) {
    open(my $list, ">", "/tmp/attr-paths") or fail(4, "could not write the paths to check: $!");
    print $list map { "$_\0" } @differ; close $list or fail(4, "could not write the paths to check: $!");
    # An attribute's value can be empty ("filter="), so empty fields are kept; only the final terminator's is dropped.
    my @fields = split /\0/, git_in_mirror("/tmp/attr-paths", "check-attr", "-z", "--stdin",
      "text", "eol", "crlf", "ident", "working-tree-encoding", "filter"), -1;
    pop @fields if @fields && $fields[-1] eq "";
    fail(4, "git check-attr returned an incomplete answer") if @fields % 3;
    while (@fields) { my ($path, $attr, $value) = splice @fields, 0, 3; $converts{$path} = 1 if $value ne "unspecified" }
    # Repository config can convert line endings for every file, with no attribute at all.
    my $pid = open(my $out, "-|", @GIT, "config", "--get-regexp", "^core\\.(autocrlf|eol)\$") or fail(4, "could not run git: $!");
    local $/; my $config = <$out> // ""; close $out;
    fail(4, "git config failed (" . exit_reason($?) . ")") if $? == -1 || ($? & 127) || ($? >> 8) > 1;
    %converts = map { $_ => 1 } @differ if $config =~ /^core\.(?:autocrlf(?! false\b)|eol )/m;
  }
  # Bytes exactly base's blob: what a checkout without conversion writes, and a file base stores unnormalized (legacy
  # CRLF under a later text rule) is written as it is too. Whatever rules the work tree has now, it is untouched.
  # This reads the file once, in the script, so it is cheap.
  $as_checked_out{$_} = 1 for grep { file_id($_) eq $base{$_}{oid} } @differ;
  # What is left and converts is compared with checkout, one Git process each (a few milliseconds apiece). Untouched
  # legacy files can need it as well as changed ones, so their number is not a change count: the run's deadline bounds
  # the work instead.
  my @compare = grep { $converts{$_} && !$as_checked_out{$_} } @differ;
  for my $path (@compare) {
    my $bytes = git_in_mirror(undef, "cat-file", "--filters", "--path=$path", $base{$path}{oid});
    $as_checked_out{$path} = 1 if blob_id($bytes) eq file_id($path);
  }
}
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
  my $content = $new->{oid} ne $old->{oid} && !$as_checked_out{$path};
  my $mode = $new->{gitMode} ne $old->{gitMode};
  $new->{oid} = $old->{oid} unless $content;
  push @changes, change($content ? "modify" : "mode", $path, $old, $new) if $content || $mode;
}
for my $path (sort keys %work) {
  next if $base{$path}; my $new = $work{$path};
  if ($collapsed{$path}) { push @changes, change("add", $path, undef, { type => "directory" }, 1); next }
  # A directory is a change only when it is new and empty: otherwise what is in it is listed.
  next if $new->{type} eq "directory" && ($base_directory{$path} || $has_child{$path});
  push @added, change("add", $path, undef, $new, $ignored{$path});
}
# An exact rename: a deleted and an added entry of the same type with the same stored content, paired in path order. An
# entry under a .git part is never stored, so it is never the new half of a rename: the deletion stays a deletion.
my %by_content;
push @{ $by_content{"$_->{newType}:$_->{newOid}"} }, $_ for grep { defined $_->{newOid} && !under_git_path($_->{path}) } @added;
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
# A populated gitlink is reported too, one name each, so it counts against the same limit.
fail(9, "more than $MAXIMUM_CHANGES changes; the change set is too large to inspect") if @changes + @nested > $MAXIMUM_CHANGES;
@changes = sort { $a->{path} cmp $b->{path} } @changes;
# The names as bytes, for the commit: the check below turns them into text for the JSON.
my @raw = map { +{ path => $_->{path}, oldPath => $_->{oldPath}, newLinkTarget => $_->{newLinkTarget} } } @changes;
# Names are checked only here, as they go into the manifest: an unchanged path with any name is never refused.
for my $change (@changes) {
  $change->{newLinkTarget} = text($change->{newLinkTarget}, "the link target of " . shown($change->{path}))
    if defined $change->{newLinkTarget};
  $change->{path} = text($change->{path}, "path");
  $change->{oldPath} = text($change->{oldPath}, "path") if defined $change->{oldPath};
}
# Where each changed link's new target leads, resolved one part at a time as the kernel would in an agent container:
# whether a part on the way, or the target itself, is another link. One that leaves the work tree or enters the
# metadata counts as traversing, since what is there cannot be checked from here.
for my $i (0 .. $#changes) {
  next unless ($changes[$i]{newType} // "") eq "symlink";
  # The joined target can be longer than either name the manifest carries, so nothing here is checked as a name.
  my $status = resolve($raw[$i]{path}, 0, 1)->{status};
  $changes[$i]{linkTargetTraversesLink} = $status eq "present" || $status eq "absent" ? JSON::PP::false : JSON::PP::true;
}

my $head = git("rev-parse", "--verify", "HEAD"); chomp $head;
my @agent_commits;
if ($head ne $base) {
  @agent_commits = split /\n/, git("rev-list", "--max-count=100", $head, "--not", $base);
  @agent_commits = ($head) unless @agent_commits;
}
my @fresh = map { resolve($_, 0) } @links;
my %targets = map { (text($_, "target") => target_state($_)) } @targets;
my %result = (metadataDigest => $metadata_digest, head => $head, agentCommits => \@agent_commits,
  changes => \@changes, nestedGitlinkContent => [map { text($_, "path") } sort @nested], links => \@fresh, targets => \%targets);
emit(\%result) if $mode eq "inspect";
# A commit reports the inspection as encoded now, before anything below reads it: nothing that builds the commit can
# change what the runner checks.
# It goes out at once, on one line (JSON::PP escapes every newline inside a string), so the build below does not hold
# it in memory beside its own work. A later failure still fails the whole run, and the runner then discards it all.
{
  my $line = $json->encode(\%result);
  fail(9, "the result is larger than $MAXIMUM_OUTPUT bytes") if length $line > $MAXIMUM_OUTPUT;
  binmode STDOUT; print $line, "\n"; STDOUT->flush;
}
%result = ();

# The runner commit: base plus exactly the changes above, each stored as hashed above. Whatever they do not list stays
# as base has it (an unchanged submodule, a symlinked .gitattributes, a file whose bytes are what checkout wrote).
# Nothing is built when the runner would refuse it anyway, or when a change is not something a tree can hold.
sub storable {
  my $change = shift; return 0 if $change->{underGit};
  # Git refuses a symlink named .gitmodules in any tree.
  return 0 if ($change->{newType} // "") eq "symlink" && lc((split m{/}, $change->{path})[-1]) eq ".gitmodules";
  for my $key (qw(oldType newType)) { my $type = $change->{$key}; return 0 if defined $type && ($type eq "directory" || $type eq "other") }
  return 1;
}
my $built;
if (@changes && $head eq $base && !@nested && !grep { !storable($_) } @changes) {
  binmode STDIN; my $request = do { local $/; <STDIN> } // "";
  $request = eval { $json->decode($request) };
  my @identity = map { my $who = ref $request eq "HASH" ? $request->{$_} : undef; ref $who eq "HASH" ? @$who{qw(name email date)} : (undef) x 3 } qw(author committer);
  # The runner checked these; a NUL cannot reach Git through the environment, nor a newline into an identity line.
  fail(2, "bad commit request") if ref $request ne "HASH" || (grep { !defined $_ || ref $_ || /[\0\n]/ } @identity)
    || !defined $request->{message} || ref $request->{message} || $request->{message} =~ /\0/;
  # Every object goes to /tmp: the metadata stays read-only, and objects base already has are read from it.
  mkdir "/tmp/objects" or fail(4, "could not create the scratch object store: $!");
  local @ENV{qw(GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES)} = ("/tmp/objects", "/work/.git/objects");
  my $null = "0" x length $base;
  # New content is hashed again, writing this time, in an index built as the scratch index was: each file's rules (the
  # work tree's attribute files, and base's own entry for it) are the same, so each must come out as the ID above. A
  # rename or a mode change stores content base already has.
  my @written = grep { $changes[$_]{kind} eq "add" || $changes[$_]{kind} eq "modify" } 0 .. $#changes;
  my @files = grep { $changes[$_]{newType} eq "file" } @written;
  if (@files) {
    local $ENV{GIT_INDEX_FILE} = "/tmp/write-index";
    hashing_index();
    open(my $list, ">", "/tmp/write-paths") or fail(4, "could not write the paths to store: $!");
    print $list map { "$raw[$_]{path}\0" } @files; close $list or fail(4, "could not write the paths to store: $!");
    git_in("/tmp/write-paths", 1, "-c", "core.protectNTFS=false", "-c", "core.protectHFS=false",
      "update-index", "--add", "--replace", "-z", "--stdin");
    my %stored;
    for my $record (split /\0/, git("ls-files", "-s", "-z")) { my ($meta, $path) = split /\t/, $record, 2; $stored{$path} = (split / /, $meta)[1] }
    for (@files) { fail(4, "git stored " . shown($raw[$_]{path}) . " differently from how it was hashed") if ($stored{$raw[$_]{path}} // "") ne $changes[$_]{newOid} }
  }
  # A link stores its target text as it is.
  my @links_written = grep { $changes[$_]{newType} eq "symlink" } @written;
  if (@links_written) {
    mkdir "/tmp/link-text" or fail(4, "could not write the link targets: $!");
    open(my $list, ">", "/tmp/link-paths") or fail(4, "could not write the link targets: $!");
    for my $i (@links_written) {
      open(my $text, ">", "/tmp/link-text/$i") or fail(4, "could not write the link targets: $!");
      binmode $text; print $text $raw[$i]{newLinkTarget}; close $text or fail(4, "could not write the link targets: $!");
      print $list "/tmp/link-text/$i\n";
    }
    close $list or fail(4, "could not write the link targets: $!");
    my @ids = split /\n/, git_in("/tmp/link-paths", 1, "hash-object", "-w", "--no-filters", "--stdin-paths");
    for my $n (0 .. $#links_written) {
      my $i = $links_written[$n];
      fail(4, "git stored the link " . shown($raw[$i]{path}) . " differently from how it was hashed") if ($ids[$n] // "") ne $changes[$i]{newOid};
    }
  }
  # The tree: base, without what was deleted or renamed away, with every other change set to its new entry.
  my ($tree, $commit);
  {
    local $ENV{GIT_INDEX_FILE} = "/tmp/commit-index";
    git("read-tree", $base);
    open(my $info, ">", "/tmp/index-info") or fail(4, "could not write the tree entries: $!");
    for my $i (0 .. $#changes) {
      my $gone = $changes[$i]{kind} eq "delete" ? $raw[$i]{path} : $changes[$i]{kind} eq "rename" ? $raw[$i]{oldPath} : undef;
      print $info "0 $null\t$gone\0" if defined $gone;
    }
    for my $i (grep { $changes[$_]{kind} ne "delete" } 0 .. $#changes) { print $info "$changes[$i]{newMode} $changes[$i]{newOid}\t$raw[$i]{path}\0" }
    close $info or fail(4, "could not write the tree entries: $!");
    git_in("/tmp/index-info", 1, "-c", "core.protectNTFS=false", "-c", "core.protectHFS=false",
      "update-index", "--add", "--replace", "-z", "--index-info");
    $tree = git("write-tree"); chomp $tree;
  }
  # Only what the runner passed decides the commit: identities and dates from the request, no signature, and UTF-8
  # with no encoding header, so its ID follows from the request, the tree and base alone.
  open(my $message, ">", "/tmp/commit-message") or fail(4, "could not write the commit message: $!");
  binmode $message; print $message Encode::encode("UTF-8", $request->{message}); close $message or fail(4, "could not write the commit message: $!");
  {
    my @values = map { Encode::encode("UTF-8", $_) } @identity;
    local @ENV{qw(GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_AUTHOR_DATE GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_COMMITTER_DATE)} =
      (@values[0, 1], "\@$values[2]", @values[3, 4], "\@$values[5]");
    $commit = git("-c", "commit.gpgSign=false", "-c", "i18n.commitEncoding=UTF-8", "commit-tree", "--no-gpg-sign", $tree,
      "-p", $base, "-F", "/tmp/commit-message");
    chomp $commit;
  }
  $built = { tree => $tree, head => $commit };
}
exit 0 unless $built;
print $json->encode($built), "\n";
# Then the commit as a bundle, from a scratch repository of the runner's own whose only ref is the commit, reading every
# object from /tmp and the metadata. Its prerequisite is base, which the runner's host repository already has.
{
  local @ENV{qw(GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_INDEX_FILE)};
  delete @ENV{qw(GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_INDEX_FILE)};
  system(@GIT, "-c", "init.defaultBranch=codeboost", "init", "-q", "--bare", "--template=", $format eq "sha256" ? ("--object-format=sha256") : (), "/tmp/bundle.git") == 0
    or fail(4, "git init failed (" . exit_reason($?) . ")");
  open(my $alternates, ">", "/tmp/bundle.git/objects/info/alternates") or fail(4, "could not write the bundle's alternates: $!");
  print $alternates "/tmp/objects\n/work/.git/objects\n"; close $alternates or fail(4, "could not write the bundle's alternates: $!");
  system(@GIT, "--git-dir=/tmp/bundle.git", "update-ref", "${TASK_COMMIT_REF}", $built->{head}) == 0
    or fail(4, "git update-ref failed (" . exit_reason($?) . ")");
  my $pid = open(my $bundle, "-|"); fail(4, "could not run git: $!") unless defined $pid;
  if (!$pid) {
    open(STDERR, ">", $stderr_file) or die "could not capture git errors: $!";
    # One thread: pack-objects otherwise starts one per host CPU, past the container's process limit.
    exec(@GIT, "--git-dir=/tmp/bundle.git", "-c", "pack.threads=1", "bundle", "create", "-q", "-", "${TASK_COMMIT_REF}",
      "^$base") or die "could not run git: $!";
  }
  # Encoded as it is read, three bytes to four, so nothing holds the whole bundle; past the limit it stops at once.
  binmode $bundle; my ($size, $pending) = (0, "");
  for (;;) {
    my $read = sysread($bundle, my $chunk, 3 * 65536); fail(4, "could not read the bundle: $!") unless defined $read;
    last unless $read;
    $size += $read;
    fail(9, "the commit's bundle is larger than $bundle_limit bytes") if $size > $bundle_limit;
    $pending .= $chunk;
    print MIME::Base64::encode_base64(substr($pending, 0, length($pending) - length($pending) % 3, ""), "");
  }
  print MIME::Base64::encode_base64($pending, "");
  close $bundle;
  fail(4, "git bundle failed (" . exit_reason($?) . ")") if $?;
}
exit 0;
`;
