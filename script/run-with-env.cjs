const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
let commandIndex = 0;

for (; commandIndex < args.length; commandIndex += 1) {
  const arg = args[commandIndex];
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
    break;
  }

  const equalsAt = arg.indexOf("=");
  process.env[arg.slice(0, equalsAt)] = arg.slice(equalsAt + 1);
}

const command = args[commandIndex];
const commandArgs = args.slice(commandIndex + 1);

if (!command) {
  console.error("Usage: node script/run-with-env.cjs KEY=value command [...args]");
  process.exit(1);
}

const child = spawn(command, commandArgs, {
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Command terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
