module.exports = {
  apps: [
    {
      name: "glab-review-webhook",
      script: "/home/coder/.bun/bin/bun",
      args: "dist/index.js",
      cwd: "/home/coder/glab-review-webhook",
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
