const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const requiredPaths = [
    path.join(projectRoot, "dist"),
    path.join(projectRoot, "dist", "index.js"),
    path.join(projectRoot, "dist", "index.d.ts"),
];

const missingPaths = requiredPaths.filter((filePath) => !fs.existsSync(filePath));

if (missingPaths.length > 0) {
    console.error("Missing build output. Run `pnpm run build` before publishing.");
    for (const filePath of missingPaths) {
        console.error(`- ${path.relative(projectRoot, filePath)}`);
    }
    process.exit(1);
}