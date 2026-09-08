#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s OUTPUT_DIRECTORY\n' "$0" >&2
  exit 2
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
mkdir -p -- "$1"
output_dir=$(cd -- "$1" && pwd -P)
for source_file in init.sh fixture.py; do
  [[ -f "$source_dir/$source_file" ]] || { printf 'Missing %s\n' "$source_file" >&2; exit 1; }
done
[[ "$output_dir" != / && "$output_dir" != "$source_dir" ]] || exit 2
for artifact in kernel initramfs.cpio.gz SHA256SUMS build-metadata.json packages.txt; do
  [[ ! -e "$output_dir/$artifact" ]] || { printf 'Output already exists: %s\n' "$artifact" >&2; exit 1; }
done

image=alpine:3.24.1
docker pull --platform linux/amd64 "$image"
image_id=$(docker image inspect --format '{{.Id}}' "$image")
image_digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$image")
docker run --rm -i --platform linux/amd64 \
  --cap-drop ALL --security-opt no-new-privileges \
  --cap-add SYS_CHROOT --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --cap-add MKNOD \
  --mount "type=bind,source=$source_dir,target=/source,readonly" \
  --mount "type=bind,source=$output_dir,target=/output" \
  --env "ENGRAM_BUILD_IMAGE_DIGEST=$image_digest" \
  --env "ENGRAM_OUTPUT_UID=$(id -u)" --env "ENGRAM_OUTPUT_GID=$(id -g)" \
  "$image_id" /bin/sh -eu -s <<'BUILD'
set -o pipefail
apk add --no-cache cpio gzip kmod coreutils
mkdir -p /build/rootfs/etc/apk /build/rootfs/dev /build/rootfs/proc /build/rootfs/sys
cp -a /etc/apk/keys /build/rootfs/etc/apk/keys
printf '%s\n' \
  https://dl-cdn.alpinelinux.org/alpine/v3.24/main \
  https://dl-cdn.alpinelinux.org/alpine/v3.24/community \
  > /build/rootfs/etc/apk/repositories
apk --root /build/rootfs --initdb --no-cache --no-scripts add \
  alpine-base linux-virt kmod eudev xorg-server xf86-input-libinput xrandr \
  xdotool xauth python3 python3-tkinter font-dejavu font-noto-cjk openbox
chroot /build/rootfs /bin/busybox --install -s
chroot /build/rootfs /usr/sbin/adduser -D -u 1000 -h /home/worker worker
mkdir -p /build/rootfs/opt/worker /build/rootfs/etc/X11/xorg.conf.d
cp /source/init.sh /build/rootfs/init
cp /source/fixture.py /build/rootfs/opt/worker/fixture.py
chmod 0755 /build/rootfs/init
chmod 0644 /build/rootfs/opt/worker/fixture.py
chown -R 1000:1000 /build/rootfs/home/worker
mknod -m 0600 /build/rootfs/dev/console c 5 1
mknod -m 0666 /build/rootfs/dev/null c 1 3

cat > /build/rootfs/etc/X11/xorg.conf.d/20-virtual-screen.conf <<'XORG'
Section "ServerFlags"
    Option "AutoAddDevices" "true"
    Option "AutoAddGPU" "true"
    Option "DontVTSwitch" "true"
EndSection
Section "Device"
    Identifier "VirtualGPU"
    Driver "modesetting"
    Option "AccelMethod" "none"
EndSection
Section "Screen"
    Identifier "VirtualScreen"
    Device "VirtualGPU"
    DefaultDepth 24
EndSection
XORG

set -- /build/rootfs/lib/modules/*
[ "$#" -eq 1 ] && [ -d "$1" ] || { printf 'Expected one guest kernel\n' >&2; exit 1; }
module_dir=$1
kernel_version=${module_dir##*/}
case "$module_dir" in /build/rootfs/lib/modules/*) ;; *) exit 1 ;; esac
depmod -b /build/rootfs "$kernel_version"
: > /build/module-files
for module in virtio_pci virtio_gpu virtio_net qemu_fw_cfg psmouse usbhid xhci_pci hid_generic evdev af_packet; do
  modprobe --dirname /build/rootfs --set-version "$kernel_version" --show-depends "$module" \
    | awk '$1 == "insmod" {print $2}' >> /build/module-files
done
sort -u /build/module-files -o /build/module-files
find "$module_dir" -type f -name '*.ko*' | while IFS= read -r module_file; do
  if ! grep -Fqx "$module_file" /build/module-files; then
    rm -- "$module_file"
  fi
done
depmod -b /build/rootfs "$kernel_version"
for module in virtio_pci virtio_gpu virtio_net qemu_fw_cfg psmouse usbhid xhci_pci hid_generic evdev af_packet; do
  modprobe --dirname /build/rootfs --set-version "$kernel_version" --show-depends "$module" >/dev/null
done

cp /build/rootfs/boot/vmlinuz-virt /output/kernel
apk --root /build/rootfs list --installed | sort > /output/packages.txt
chroot /build/rootfs /usr/bin/python3 -m py_compile /opt/worker/fixture.py
chroot /build/rootfs /bin/sh -n /init
rootfs_bytes=$(du -sb /build/rootfs | cut -f1)
[ "$rootfs_bytes" -le 536870912 ] || { printf 'Guest rootfs exceeds 512 MiB: %s\n' "$rootfs_bytes" >&2; exit 1; }
cd /build/rootfs
find . -path ./boot -prune -o -path ./proc -prune -o \
  -path ./sys -prune -o -print0 | sort -z | cpio --null -o --format=newc --reproducible \
  | gzip -n -6 > /output/initramfs.cpio.gz
image_bytes=$(stat -c %s /output/initramfs.cpio.gz)
[ "$image_bytes" -le 268435456 ] || { printf 'Guest initramfs exceeds 256 MiB\n' >&2; exit 1; }
printf '{"architecture":"x86_64","image":"%s","kernel":"%s","rootfsBytes":%s,"initramfsBytes":%s}\n' \
  "$ENGRAM_BUILD_IMAGE_DIGEST" "$kernel_version" "$rootfs_bytes" "$image_bytes" \
  > /output/build-metadata.json
cd /output
sha256sum kernel initramfs.cpio.gz packages.txt build-metadata.json > SHA256SUMS
chown "$ENGRAM_OUTPUT_UID:$ENGRAM_OUTPUT_GID" kernel initramfs.cpio.gz SHA256SUMS build-metadata.json packages.txt
BUILD
printf 'Guest image prepared in %s\n' "$output_dir"
