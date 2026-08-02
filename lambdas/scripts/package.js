const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const stagingDir = path.join(root, ".lambda-package");
const archivePath = path.join(root, "lambda-package.zip");

const removeIfExists = (target) => {
  fs.rmSync(target, { recursive: true, force: true });
};

removeIfExists(distDir);
removeIfExists(stagingDir);
removeIfExists(archivePath);

execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
  cwd: root,
  stdio: "inherit",
});

fs.cpSync(distDir, stagingDir, { recursive: true });
fs.copyFileSync(path.join(root, "package.json"), path.join(stagingDir, "package.json"));
fs.copyFileSync(path.join(root, "package-lock.json"), path.join(stagingDir, "package-lock.json"));

execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["ci", "--omit=dev", "--ignore-scripts", "--prefix", stagingDir],
  { cwd: root, stdio: "inherit" },
);

execFileSync("zip", ["-r", archivePath, "."], {
  cwd: stagingDir,
  stdio: "inherit",
});

removeIfExists(stagingDir);
console.log(`Created ${path.relative(root, archivePath)}`);
