const { execSync } = require("child_process");

const bunPath = execSync("which bun", { encoding: "utf8" }).trim();

module.exports = {
  apps: [
    {
      name: "glab-review-webhook",
      script: bunPath,
      args: "dist/index.js",
      cwd: __dirname,
      env_file: ".env",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      merge_logs: true,
    },
  ],
};
