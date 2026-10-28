#!/bin/sh
# Retired: thecollector-backend.service (systemd user unit) supervises the
# Collector backend on port 3000, restarts it after a crash, and starts it with
# --max-old-space-size=24576.
#
# This file stays inert so an old launcher cannot start a second server that
# competes for port 3000 with the supervised process.
exit 0
