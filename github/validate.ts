/** Shapes the GitHub adapters accept, kept in one place so the adapters cannot drift apart. */
export const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const SHA = /^[a-f0-9]{40}$/;
/** A conservative branch name: no leading dash, no `..` or `//`, no trailing `.` or `/`. */
export const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![./])$/;
