  What you do in the fresh session

  1. The dashboard for gdpr is already running on localhost:7779. If you ever need to restart it:

  CLAUDE_PROJECT_DIR=/mnt/nvme2TB/gdpr CV_PORT=7779 \
    node /mnt/nvme2TB/claude_view_mcp/packages/server/dist/server.js &

  2. Open Claude in gdpr with the plugin loaded:

  cd /mnt/nvme2TB/gdpr
  claude --plugin-dir /mnt/nvme2TB/claude_view_mcp

  That's it. The SessionStart hook fires automatically and injects the 723-token brief you just saw — so the fresh Claude starts already knowing the 19 dead ends and 3 criticals. The cv_* MCP tools will be there, plus /cv, /cv-init, /cv-drain.
