const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function runTsc(mode = "build") {
    const projectRoot = path.resolve(__dirname, "..");
    const tsconfigPath = path.join(projectRoot, "tsconfig.json");

    if (mode === "build") {
        fs.rmSync(path.join(projectRoot, "dist"), { recursive: true, force: true });
    }

    const tscBin = require.resolve("typescript/bin/tsc", { paths: [projectRoot] });
    const args = [tscBin, "-p", tsconfigPath];

    if (mode === "check") {
        args.push("--noEmit");
    }

    const result = spawnSync(process.execPath, args, {
        cwd: projectRoot,
        stdio: "inherit",
        env: process.env,
    });

    if (result.error) {
        throw result.error;
    }

    if (typeof result.status === "number") {
        process.exit(result.status);
    }

    process.exit(1);
}

module.exports = runTsc;

if (require.main === module) {
    runTsc(process.argv[2] ?? "build");
}