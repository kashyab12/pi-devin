import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const files = (await readdir("test")).filter((file) => file.endsWith(".test.mjs")).map((file) => join("test", file));
const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "--test", ...files], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
