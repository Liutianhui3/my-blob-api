#!/usr/bin/env bash
set -euo pipefail

archive="$1"
release_id="$2"
[[ "$release_id" =~ ^[0-9]+-[0-9]+$ ]]
[[ "$archive" == "/tmp/myblob-api-${release_id}.tar.gz" ]]
test "$(id -u)" -eq 0

base=/srv/myblob
release="$base/api-releases/$release_id"
dropin_dir=/etc/systemd/system/myblob-api.service.d
dropin="$dropin_dir/90-github-release.conf"
test -s "$base/my-blob-api/.env"
id blob > /dev/null
systemctl cat myblob-api > /dev/null
mkdir -p "$base/api-releases" "$dropin_dir"
mkdir "$release"
tar -xzf "$archive" -C "$release"
test -s "$release/dist/main.js"

# Install before changing the running service. The environment stays on the server.
chown -R blob:blob "$release"
runuser -u blob -- bash -c 'cd "$1" && npm ci --omit=dev' bash "$release"
ln -s "$base/my-blob-api/.env" "$release/.env"
runuser -u blob -- test -r "$release/.env"

backup=$(mktemp)
had_override=false
if test -f "$dropin"; then
  cp "$dropin" "$backup"
  had_override=true
fi

rollback() {
  result=$?
  trap - EXIT
  if test "$result" -ne 0; then
    echo 'Deployment failed; restoring the previous service configuration.'
    journalctl -u myblob-api -n 40 --no-pager || true
    if "$had_override"; then
      cp "$backup" "$dropin"
    else
      rm -f "$dropin"
    fi
    systemctl daemon-reload
    systemctl restart myblob-api || true
    echo 'Code rollback does not undo database schema changes.'
  fi
  rm -f "$backup" "$archive"
  exit "$result"
}
trap rollback EXIT

cat > "$dropin" <<EOF
[Service]
WorkingDirectory=$release
ExecStart=
ExecStart=/usr/bin/node $release/dist/main.js
EOF

systemctl daemon-reload
systemctl restart myblob-api

# The authenticated endpoint returns 401 when the API and its database initialized.
for attempt in $(seq 1 30); do
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 2 --max-time 3 http://127.0.0.1:3000/api/users/me || true)
  if test "$status" = 401 && systemctl is-active --quiet myblob-api; then
    echo "Backend release $release_id is running."
    exit 0
  fi
  sleep 2
done

echo 'Backend did not become ready within the deployment timeout.'
exit 1
