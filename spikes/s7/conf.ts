// S7: prints the tmux config dwa generates, for a server started by hand.
import { buildTmuxConf } from "../../src/tmux/conf.ts";

console.log(
  buildTmuxConf({
    selfArgv: ["bun", `${process.cwd()}/src/cli/index.ts`],
    projectRoot: process.argv[2] ?? process.cwd(),
  }),
);
