/**
 * The Perl program D runs inside task storage to read it without following links (#66). One program serves three modes,
 * so the seeder's metadata baseline and a later inspection compute the metadata digest the same way:
 *
 * - `digest <root>` prints one SHA-256 over every entry under `root`: its path, inode, mode, owner, size, ctime, mtime
 *   and link target. ctime changes on every write, chmod, chown, link or rename, and no one without CAP_SYS_TIME can set
 *   it, so an equal digest means nothing under `root` was touched.
 * - `snapshot <link>...` (in /work) resolves each declared link as the kernel would, one part at a time, and records
 *   the state of its target and everything beneath it.
 * - `inspect <base> <link>... -- <target>...` (in /work) compares the work tree with the tree of `base`, resolves each
 *   declared link again, and reports the state of each target recorded before launch, the metadata digest and HEAD.
 *
 * Output is one JSON document on stdout. A path or link target that is not strict UTF-8 without control characters
 * cannot be put in the manifest, and more than MAXIMUM_CHANGES changes or MAXIMUM_TARGET_ENTRIES target entries cannot
 * be returned whole; both fail the run (exit 8 and 9) rather than return part of the answer. A directory or file it
 * cannot read fails it too (exit 6), since what is inside is unknown. Exit 3 is a bad base, exit 4 a Git failure.
 */
export const MAXIMUM_CHANGES = 10_000;
/** Entries recorded beneath all declared links' targets together, in one snapshot or inspection. */
export const MAXIMUM_TARGET_ENTRIES = 20_000;
/** Enough for the largest output the limits above allow: a change or entry is under 5 KiB even with a 4 KiB link target. */
export const MAXIMUM_TREE_OUTPUT = (MAXIMUM_CHANGES + 2 * MAXIMUM_TARGET_ENTRIES) * 5 * 1024;

export const TREE_SCRIPT = String.raw`
use strict; use warnings;
use Time::HiRes qw(lstat); use Digest::SHA; use JSON::PP; use Encode (); use Fcntl qw(O_RDONLY O_NOFOLLOW);
$SIG{__WARN__} = sub { die @_ };
my $mode = shift @ARGV // "";
my ($MAXIMUM_CHANGES, $MAXIMUM_TARGET_ENTRIES) = (${MAXIMUM_CHANGES}, ${MAXIMUM_TARGET_ENTRIES});

# An agent-chosen name goes into an error message escaped onto one printable line.
sub shown { my $p = shift; $p =~ s/([^\w.\/ -])/sprintf("\\x%02x", ord $1)/ge; return $p }
sub fail { my ($code, $message) = @_; print STDERR "$message\n"; exit $code }
# The manifest carries names as JSON text. Strict UTF-8 refuses surrogates and code points past U+10FFFF, which a lax
# decoder would pass and Node would turn into U+FFFD, so two different names could show as one.
sub text {
  my ($bytes, $what) = @_;
  my $text = eval { Encode::decode("UTF-8", $bytes, Encode::FB_CROAK | Encode::LEAVE_SRC) };
  fail(8, "$what " . shown($bytes) . " is not printable UTF-8") if !defined $text || $text =~ /[\x00-\x1f\x7f]/;
  return $text;
}
sub children {
  my $dir = shift;
  opendir(my $handle, $dir) or fail(6, "could not read directory " . shown($dir) . ": $!");
  my @names = grep { $_ ne "." && $_ ne ".." } readdir $handle; closedir $handle; return sort @names;
}
sub join_path { my ($dir, $name) = @_; return $dir eq "." || $dir eq "" ? $name : "$dir/$name" }

# Paths are hashed relative to the root, so the seeder (at /metadata) and an inspection (at /work/.git) agree.
sub metadata_digest {
  my $root = shift; my $sha = Digest::SHA->new(256); my @pending = (".");
  while (@pending) {
    my $path = shift @pending; my $full = $path eq "." ? $root : "$root/$path";
    my @stat = lstat $full; fail(6, "could not stat metadata " . shown($path) . ": $!") unless @stat;
    my $target = -l _ ? readlink $full : "";
    $sha->add(join("\0", $path, @stat[1, 2, 4, 5, 7, 10, 9], $target), "\0");
    unshift @pending, map { join_path($path, $_) } children($full) if -d _;
  }
  return $sha->hexdigest;
}
if ($mode eq "digest") { print metadata_digest(shift @ARGV), "\n"; exit 0 }

chdir "/work" or fail(6, "could not enter the work tree: $!");
my %keep = map { $_ => 1 } qw(GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL GIT_OPTIONAL_LOCKS GIT_TERMINAL_PROMPT GIT_NO_LAZY_FETCH);
delete $ENV{$_} for grep { /^GIT_/ && !$keep{$_} } keys %ENV;
@ENV{qw(HOME GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL GIT_OPTIONAL_LOCKS GIT_TERMINAL_PROMPT GIT_NO_LAZY_FETCH)} =
  ("/tmp", "1", "/dev/null", "0", "0", "1");
# Git reads only trusted repository config. Hooks, fsmonitor and the attributes and excludes files are off, the stat
# checks are pinned to their strict defaults, and a safecrlf warning cannot stop a hash.
my @GIT = ("git", "--no-pager", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
  "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "core.ignorecase=false",
  "-c", "core.trustctime=true", "-c", "core.checkStat=default", "-c", "core.filemode=true", "-c", "core.symlinks=true",
  "-c", "core.ignoreStat=false", "-c", "core.safecrlf=false", "-c", "core.untrackedCache=false");
# Run Git with the given work tree, optionally feeding it a file, and return its standard output.
sub git_in {
  my ($worktree, $input, @args) = @_;
  my $pid = open(my $out, "-|"); fail(4, "could not run git: $!") unless defined $pid;
  if (!$pid) {
    if (defined $input) { open(STDIN, "<", $input) or die "could not open git input: $!" }
    exec(@GIT, "-c", "core.worktree=$worktree", @args) or die "could not run git: $!";
  }
  local $/; my $output = <$out> // ""; close $out;
  fail(4, "git $args[0] failed (status " . ($? >> 8) . ")") if $?;
  return $output;
}
sub git { return git_in("/work", undef, @_) }

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
# One entry as lstat sees it, for the work tree walk. Git modes for what Git can store; other types carry none.
sub entry {
  my $path = shift; my @stat = lstat $path; return undef unless @stat;
  my %entry = (ino => $stat[1], mode => sprintf("%o", $stat[2]), size => $stat[7], ctime => "$stat[10]", mtime => "$stat[9]");
  if (-l _) { my $target = readlink $path; @entry{qw(type gitMode oid linkTarget)} = ("symlink", "120000", blob_id($target), text($target, "the link target of " . shown($path))) }
  elsif (-f _) { @entry{qw(type gitMode)} = ("file", ($stat[2] & 0100) ? "100755" : "100644") }
  elsif (-d _) { $entry{type} = "directory" }
  else { $entry{type} = "other" }
  return \%entry;
}
# A target entry also carries the file's raw content ID: the snapshot compares identity, not what Git would store.
sub target_entry { my $path = shift; my $entry = entry($path); $entry->{oid} = file_id($path) if $entry->{type} eq "file"; return { path => text($path, "path"), %$entry } }

# Resolve a declared link as the kernel does, one part at a time. A part that is a link, before ".." or before the last
# part, stops it (through-link); a missing part, or one that is not a directory, leaves it dangling (absent), with the
# nearest existing entry as its anchor. Only a target reached through real directories is watched as a target.
my $target_entries = 0;
sub anchored { my ($status, $path) = @_; return { status => $status, anchor => target_entry($path eq "" ? "." : $path) } }
sub resolve {
  my $link = shift; my %record = (link => text($link, "declared path"));
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
  return { %record, status => "outside" } if $raw =~ m{^/};
  my @parts = grep { $_ ne "" && $_ ne "." } split m{/}, $raw; my @resolved = @parents;
  for my $i (0 .. $#parts) {
    if ($parts[$i] eq "..") { return { %record, status => "outside" } unless @resolved; pop @resolved; next }
    push @resolved, $parts[$i];
    return { %record, status => "metadata" } if $resolved[0] eq ".git";
    next if $i == $#parts;
    my $path = join "/", @resolved; my @at = lstat $path;
    return { %record, %{ anchored("absent", join "/", @resolved[0 .. $#resolved - 1]) } } unless @at;
    return { %record, %{ anchored("through-link", $path) } } if -l _;
    return { %record, %{ anchored("absent", $path) } } unless -d _;
  }
  return { %record, status => "outside" } unless @resolved;
  return { %record, status => "metadata" } if $resolved[0] eq ".git";
  my $target = join "/", @resolved;
  return { %record, target => text($target, "path"), %{ target_state($target) } };
}
# The state of a target whose parents are real directories: absent (anchored on its parent), or present with every
# entry beneath it, walked without following links.
sub target_state {
  my $target = shift; my @parents = split m{/}, $target; pop @parents;
  my @stat = lstat $target;
  return anchored("absent", join "/", @parents) unless @stat;
  my @entries; my @pending = ($target);
  while (@pending) {
    my $path = shift @pending;
    fail(9, "declared link targets hold more than $MAXIMUM_TARGET_ENTRIES entries") if ++$target_entries > $MAXIMUM_TARGET_ENTRIES;
    my $entry = target_entry($path); push @entries, $entry;
    unshift @pending, map { "$path/$_" } children($path) if $entry->{type} eq "directory";
  }
  return { status => "present", entries => \@entries };
}
my $json = JSON::PP->new->utf8->canonical;

if ($mode eq "snapshot") { print $json->encode({ links => [map { resolve($_) } @ARGV] }); exit 0 }

fail(2, "unknown mode") unless $mode eq "inspect";
my $base = shift @ARGV;
fail(3, "base is not a full commit ID") unless $base =~ /^[0-9a-f]{40}([0-9a-f]{24})?$/;
fail(3, "base $base is not a commit in this task storage")
  unless system(@GIT, "cat-file", "-e", "$base^{commit}") == 0;
my (@links, @targets); my $list = \@links;
for my $argument (@ARGV) { if ($argument eq "--") { $list = \@targets } else { push @$list, $argument } }

# The tree of base: every blob and gitlink, and every directory above one. Its .gitignore files are the only ignore
# rules that count: the agent's own edits to them do not decide what the audit sees.
my (%base, %base_directory);
mkdir "/tmp/ignore" or fail(4, "could not create the ignore tree: $!");
for my $record (split /\0/, git("ls-tree", "-r", "-z", "--full-tree", $base)) {
  my ($meta, $path) = split /\t/, $record, 2; my ($git_mode, $kind, $oid) = split / /, $meta;
  text($path, "path");
  $base{$path} = { gitMode => $git_mode, oid => $oid,
    type => $git_mode eq "160000" ? "gitlink" : $git_mode eq "120000" ? "symlink" : "file" };
  my @parts = split m{/}, $path; my $name = pop @parts;
  $base_directory{join "/", @parts[0 .. $_]} = 1 for 0 .. $#parts;
  if ($name eq ".gitignore" && $git_mode =~ /^1006/) {
    my $dir = "/tmp/ignore"; for my $part (@parts) { $dir .= "/$part"; mkdir $dir unless -d $dir }
    open(my $file, ">", "$dir/.gitignore") or fail(4, "could not write the ignore tree: $!");
    binmode $file; print $file git("cat-file", "blob", $oid); close $file or fail(4, "could not write the ignore tree: $!");
  }
}

# The work tree, walked without following links. The top-level .git is the metadata mount, read separately. A gitlink
# directory is not entered: anything in it, or a gitlink directory it cannot read, is nested content.
my (%work, @nested, %has_child);
my @pending = grep { $_ ne ".git" } children(".");
while (@pending) {
  my $path = shift @pending; text($path, "path");
  my $entry = entry($path) // fail(6, "could not stat " . shown($path) . ": $!");
  $work{$path} = $entry;
  my @parts = split m{/}, $path; pop @parts; $has_child{join "/", @parts} = 1 if @parts;
  next unless $entry->{type} eq "directory";
  if ((($base{$path} // {})->{type} // "") eq "gitlink") {
    my $ok = opendir(my $handle, $path); my @inside = $ok ? grep { $_ ne "." && $_ ne ".." } readdir $handle : ();
    push @nested, $path if !$ok || @inside; next;
  }
  unshift @pending, map { "$path/$_" } children($path);
}

# Tracked paths whose stat no longer matches the index. The seeder refreshed the index from base and nothing but
# codeboost writes the metadata, so any other tracked file is as base has it: its ctime, which no agent can set, is
# unchanged. Gitlinks are handled above; Git never looks inside one.
my %touched;
{
  my @fields = split /\0/, git("diff-files", "--raw", "-z", "--ignore-submodules=all", "--no-renames");
  while (@fields) { shift @fields; my $path = shift @fields; $touched{$path} = 1 if defined $path }
}

# What Git would ignore under base's rules. An ignored directory with no tracked entry beneath it is reported as one
# entry; what is inside it is not listed.
my @untracked = grep { !$base{$_} } sort keys %work;
open(my $candidates, ">", "/tmp/ignore-candidates") or fail(4, "could not write the ignore candidates: $!");
print $candidates map { ($work{$_}{type} eq "directory" ? "$_/" : $_) . "\0" } @untracked;
close $candidates or fail(4, "could not write the ignore candidates: $!");
my %ignored;
{
  # check-ignore exits 1 when nothing is ignored, so it runs outside git_in, which fails on any non-zero status.
  my $pid = open(my $out, "-|"); fail(4, "could not run git: $!") unless defined $pid;
  if (!$pid) {
    open(STDIN, "<", "/tmp/ignore-candidates") or die; chdir "/tmp/ignore" or die; $ENV{GIT_DIR} = "/work/.git";
    exec(@GIT, "--work-tree=/tmp/ignore", "check-ignore", "--no-index", "-z", "--stdin") or die;
  }
  local $/; my $output = <$out> // ""; close $out;
  fail(4, "git check-ignore failed (status " . ($? >> 8) . ")") if $? >> 8 > 1 || ($? & 127);
  for (split /\0/, $output) { s{/\z}{}; $ignored{$_} = 1 }
}
my %collapsed;
for my $path (@untracked) {
  my @parts = split m{/}, $path; my $prefix = "";
  for my $part (@parts[0 .. $#parts - 1]) { $prefix = join_path($prefix, $part); if ($collapsed{$prefix}) { $collapsed{$path} = "inside"; last } }
  next if $collapsed{$path};
  $collapsed{$path} = "top" if $ignored{$path} && $work{$path}{type} eq "directory" && !$base_directory{$path};
}

# Git blob IDs for what would be committed: changed tracked files and new files, hashed by Git with the work tree's
# attributes, exactly as a commit would store them.
my @hash = grep { $work{$_}{type} eq "file" && (!$base{$_} ? !$collapsed{$_} : $touched{$_} || $base{$_}{type} ne "file") } sort keys %work;
if (@hash) {
  open(my $list, ">", "/tmp/hash-paths") or fail(4, "could not write the paths to hash: $!");
  # Git unquotes a line that starts with a double quote, so every path goes in quoted: a name is only ever a name.
  print $list map { (my $q = $_) =~ s/(["\\])/\\$1/g; "\"$q\"\n" } @hash;
  close $list or fail(4, "could not write the paths to hash: $!");
  my @ids = split /\n/, git_in("/work", "/tmp/hash-paths", "hash-object", "--stdin-paths");
  fail(4, "git hash-object returned " . scalar(@ids) . " IDs for " . scalar(@hash) . " files") unless @ids == @hash;
  $work{$hash[$_]}{oid} = $ids[$_] for 0 .. $#hash;
}

sub under_git { return (grep { lc $_ eq ".git" } split m{/}, shift) ? JSON::PP::true : JSON::PP::false }
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
  # An untouched file keeps base's blob; its mode is still compared, since lstat saw it.
  $new->{oid} //= $old->{oid};
  my ($content, $mode) = ($new->{oid} ne $old->{oid}, $new->{gitMode} ne $old->{gitMode});
  push @changes, change($content ? "modify" : "mode", $path, $old, $new) if $content || $mode;
}
for my $path (@untracked) {
  next if ($collapsed{$path} // "") eq "inside"; my $new = $work{$path};
  if (($collapsed{$path} // "") eq "top") { push @changes, change("add", $path, undef, { type => "directory" }, 1); next }
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
my @fresh = map { resolve($_) } @links;
my %targets = map { (text($_, "target") => target_state($_)) } @targets;
print $json->encode({ metadataDigest => metadata_digest("/work/.git"), head => $head, agentCommits => \@agent_commits,
  changes => \@changes, nestedGitlinkContent => [map { text($_, "path") } sort @nested], links => \@fresh, targets => \%targets });
`;
