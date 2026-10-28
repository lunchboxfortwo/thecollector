# Collector backend supervision

`thecollector-backend.service` is the reviewed systemd user unit for the
deployed Collector backend on port 3000. It starts the server with
`--max-old-space-size=24576`, the heap measured by `probe.mjs` for the model
build over ~3.4M sales, and restarts it after any exit.

Install and enable it as the user that owns the deployment:

```sh
cp thecollector-backend.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now thecollector-backend.service
```

The user must have lingering enabled (`loginctl show-user "$USER" -p Linger`
should print `Linger=yes`) so the service survives logout and agent-session
recycling.

Verify it is the process that owns the port and that the app prices a real
request:

```sh
systemctl --user show thecollector-backend.service -p ActiveState -p MainPID -p NRestarts
ss -ltnp 'sport = :3000'
curl -s http://127.0.0.1:3000/health
curl -s -X POST http://127.0.0.1:3000/appraise \
  -H 'content-type: application/json' \
  -d '{"hints":{"artist":"Yayoi Kusama","title":"Infinity Nets","medium":"acrylic on canvas"}}'
```

`collector-keepalive-retired.sh` replaces an older background keepalive loop.
The loop matched a relative node command line that the service does not use,
so it kept starting a second backend; the stub is intentionally inert so it
cannot compete for port 3000.
