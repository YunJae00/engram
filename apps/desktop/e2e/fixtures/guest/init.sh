#!/bin/sh
set -eu
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

fail() {
  trap - EXIT
  printf 'Guest initialization failed: %s\n' "$1" >&2
  for log_file in /var/log/Xorg.0.log /run/xorg.log /run/worker.log /run/openbox.log \
    /run/dhcp.log /run/xauth.log /run/xrandr.log; do
    [ -f "$log_file" ] || continue
    printf 'Guest log: %s\n' "$log_file" >&2
    tail -n 40 "$log_file" | ENGRAM_LOG_TOKEN="${ENGRAM_GUEST_TOKEN:-}" \
      ENGRAM_LOG_COOKIE="${cookie:-}" awk '
      function redact(line, secret, prefix, position) {
        if (secret == "") return line;
        prefix = "";
        while ((position = index(line, secret)) > 0) {
          prefix = prefix substr(line, 1, position - 1) "[redacted]";
          line = substr(line, position + length(secret));
        }
        return prefix line;
      }
      { print substr(redact(redact($0, ENVIRON["ENGRAM_LOG_TOKEN"]), ENVIRON["ENGRAM_LOG_COOKIE"]), 1, 512); }
      ' | head -c 8192 >&2 || true
    printf '\n' >&2
  done
  poweroff -f
  exit 1
}

trap 'fail "unexpected startup error"' EXIT
mkdir -p /dev /proc /sys /run /tmp /var/log /dev/pts /run/udev
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
exec </dev/console >/dev/console 2>&1
if dmesg | grep -q 'Initramfs unpacking failed'; then
  fail "root filesystem extraction incomplete"
fi
mkdir -p /dev/pts
mount -t devpts -o mode=0620,gid=5 devpts /dev/pts
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /run
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /tmp
mkdir -p /run/udev /run/worker /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
hostname engram-worker
for module in virtio_pci virtio_gpu virtio_net qemu_fw_cfg psmouse usbhid xhci_pci hid_generic evdev af_packet; do
  modprobe "$module" || fail "required virtual device unavailable"
done
udevd --daemon
udevadm trigger --action=add
udevadm settle --timeout=20
[ -c /dev/dri/card0 ] || fail "virtual graphics device unavailable"

fw_dir=/sys/firmware/qemu_fw_cfg/by_name/opt/engram
[ -r "$fw_dir/worker-id/raw" ] && [ -r "$fw_dir/token/raw" ] || fail "worker configuration missing"
ENGRAM_WORKER_ID=$(tr -d '\000' < "$fw_dir/worker-id/raw")
ENGRAM_GUEST_TOKEN=$(tr -d '\000' < "$fw_dir/token/raw")
ENGRAM_BOOT_ID=$(cat /proc/sys/kernel/random/boot_id)
case "$ENGRAM_WORKER_ID" in ''|*[!a-zA-Z0-9_-]*) fail "invalid worker identifier" ;; esac
case "$ENGRAM_GUEST_TOKEN" in ''|*[!a-zA-Z0-9_-]*) fail "invalid worker token" ;; esac
[ "${#ENGRAM_GUEST_TOKEN}" -ge 32 ] && [ "${#ENGRAM_GUEST_TOKEN}" -le 256 ] || fail "invalid worker token length"
[ "${#ENGRAM_WORKER_ID}" -le 64 ] || fail "invalid worker identifier length"
export ENGRAM_WORKER_ID ENGRAM_GUEST_TOKEN ENGRAM_BOOT_ID
export DISPLAY=:0 XAUTHORITY=/run/worker/Xauthority

ip link set lo up
ip link set eth0 up
cat > /run/dhcp-script <<'DHCP'
#!/bin/sh
set -eu
case "$1" in
  bound|renew)
    [ "$interface" = eth0 ] || exit 1
    ifconfig "$interface" "$ip" netmask "$subnet" up
    ;;
  deconfig) ip addr flush dev "$interface" ;;
esac
DHCP
chmod 0700 /run/dhcp-script
udhcpc -i eth0 -n -q -t 5 -T 2 -s /run/dhcp-script >/run/dhcp.log 2>&1 \
  || fail "virtual network unavailable"

cookie=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
[ "${#cookie}" -eq 32 ] || fail "display authorization unavailable"
xauth -f "$XAUTHORITY" add :0 MIT-MAGIC-COOKIE-1 "$cookie" >/run/xauth.log 2>&1
unset cookie
chown -R 1000:1000 /run/worker
chmod 0700 /run/worker
chmod 0600 "$XAUTHORITY"
setsid Xorg :0 vt1 -keeptty -noreset -nolisten tcp -auth "$XAUTHORITY" \
  -logfile /var/log/Xorg.0.log >/run/xorg.log 2>&1 &
xorg_pid=$!
display_ready=0
for attempt in $(seq 1 40); do
  kill -0 "$xorg_pid" 2>/dev/null || fail "display server exited"
  if xrandr --query >/run/xrandr.log 2>&1; then
    display_ready=1
    break
  fi
  sleep 0.5
done
[ "$display_ready" -eq 1 ] || fail "display initialization timed out"
grep -q '^Virtual-1 connected' /run/xrandr.log || fail "unexpected display output"
xrandr --output Virtual-1 --mode 1280x800 || fail "initial display mode unavailable"
export HOME=/home/worker USER=worker LOGNAME=worker
su -s /bin/sh -p worker -c 'exec openbox' >/run/openbox.log 2>&1 &
openbox_pid=$!
su -s /bin/sh -p worker -c 'exec python3 /opt/worker/fixture.py' >/run/worker.log 2>&1 &
worker_pid=$!
printf 'Guest worker ready: %s\n' "$ENGRAM_WORKER_ID"
trap 'kill "$worker_pid" "$openbox_pid" "$xorg_pid" 2>/dev/null || true; poweroff -f' TERM INT
while kill -0 "$worker_pid" 2>/dev/null && kill -0 "$xorg_pid" 2>/dev/null; do
  sleep 1
done
fail "worker or display process exited"
