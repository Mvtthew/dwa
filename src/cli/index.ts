#!/usr/bin/env bun
import pkg from "../../package.json" with { type: "json" };
import { APP_NAME } from "../shared/constants.ts";
import { doctor } from "./doctor.ts";

const USAGE = `${APP_NAME} ${pkg.version}

Usage: ${APP_NAME} <command>

Commands:
  doctor     Check that bun, tmux and the Claude command are present and new enough
  version    Print the version
  help       Show this help
`;

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  switch (command) {
    case "doctor":
      return doctor();
    case "version":
    case "--version":
    case "-v":
      console.log(pkg.version);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      return 2;
  }
}

process.exit(await main(process.argv.slice(2)));
