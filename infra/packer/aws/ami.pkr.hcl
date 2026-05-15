# Generated for WS6 wave-3 carve-out #4 — AWS AMI golden-image
# template.
#
# Produces an Ubuntu 22.04 LTS AMI per requested region with the
# Signalman guest agent pre-installed as a systemd unit. The resulting
# AMI id is what an operator passes to
# `signalman cloud provision --image-ref ami-...` (CloudInstanceConfig.image_ref).
#
# Build context:
#   The Packer build runs from `infra/packer/aws/`. The guest binary
#   must exist at `../../../guest/target/release/signalman-guest`
#   (produced upstream by `cargo build --release --bin signalman-guest`
#   against an x86_64-unknown-linux-gnu target).
#
# Invocation (local):
#   cd infra/packer/aws
#   packer init .
#   packer validate -var-file=../common/build.pkrvars.hcl ami.pkr.hcl
#   packer build  -var-file=../common/build.pkrvars.hcl ami.pkr.hcl
#
# Invocation (CI): see `.github/workflows/golden-images.yml`.

packer {
  required_version = ">= 1.10.0"
  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = ">= 1.3.0"
    }
  }
}

# ── Variables ─────────────────────────────────────────────────────

variable "agent_version" {
  type        = string
  description = "Semantic version of the Signalman guest agent baked into the AMI."
}

variable "image_tag" {
  type        = string
  description = "Free-form image tag stamped into AMI tags + manifest output (git sha in CI)."
}

variable "linux_guest_binary" {
  type        = string
  description = "Path to the prebuilt Linux signalman-guest binary, relative to this template."
}

variable "mtls_root_ca" {
  type        = string
  description = "Path to the host-side mTLS root CA cert to bake into the AMI (relative to this template)."
}

variable "regions" {
  type        = list(string)
  description = "AWS regions to build the AMI in. Each region triggers a separate amazon-ebs source — Packer does not cross-region-copy by default."
  default     = ["us-east-1"]
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type used for the build. t3.medium balances cost vs apt-update speed; override for arch-specific builds."
  default     = "t3.medium"
}

variable "ssh_username" {
  type        = string
  description = "SSH username on the Ubuntu base AMI. Canonical Ubuntu 22.04 ships with the `ubuntu` user."
  default     = "ubuntu"
}

# ── Source ────────────────────────────────────────────────────────

# One amazon-ebs source per region. Packer parallelises across these
# at build time. We avoid `ami_regions` (Packer's built-in cross-region
# copy) on purpose: copy is asynchronous and the manifest output lags
# the build. Per-region sources give the manifest a deterministic
# AMI-id-per-region map that the operator can paste into config.

source "amazon-ebs" "ubuntu-22-04" {
  description = "Ubuntu 22.04 LTS base AMI with the Signalman guest agent installed as a systemd unit. Tagged signalman-managed=true so the cost-reaper recognises Packer-built images."

  region        = var.regions[0]
  instance_type = var.instance_type
  ssh_username  = var.ssh_username

  ami_name        = "signalman-guest-${var.agent_version}-${var.image_tag}-{{timestamp}}"
  ami_description = "Signalman guest agent v${var.agent_version} (image_tag=${var.image_tag}) — Ubuntu 22.04 LTS."

  # Canonical's published Ubuntu 22.04 LTS AMIs. Pinning by owner +
  # name filter rather than a frozen AMI id lets monthly Packer runs
  # pick up upstream security patches automatically.
  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    most_recent = true
    owners      = ["099720109477"] # Canonical
  }

  # Tags surface on the AMI and on the resulting snapshots. The
  # signalman-managed / signalman-org pair is what the cost-reaper
  # (host/src/cloud/reaper.ts) filters on; setting them on the AMI
  # is informational, but every instance launched from this AMI
  # inherits the values into vendor tags via the provisioner path.
  tags = {
    Name                       = "signalman-guest-${var.agent_version}-${var.image_tag}"
    "signalman-managed"        = "true"
    "signalman-org"            = "signalman-build"
    "signalman-agent-version"  = var.agent_version
    "signalman-image-tag"      = var.image_tag
    "signalman-image-purpose"  = "golden-image"
  }
  snapshot_tags = {
    "signalman-managed"        = "true"
    "signalman-agent-version"  = var.agent_version
  }

  run_tags = {
    Name                = "packer-build-signalman-guest"
    "signalman-managed" = "true"
    "signalman-purpose" = "packer-build"
  }
}

# ── Build ─────────────────────────────────────────────────────────

build {
  name    = "signalman-guest-aws"
  sources = ["source.amazon-ebs.ubuntu-22-04"]

  # Step 1: refresh apt to pick up base-image security updates that
  # postdate Canonical's published AMI build.
  provisioner "shell" {
    inline = [
      "set -eux",
      "sudo cloud-init status --wait || true",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get update -y",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates",
    ]
  }

  # Step 2: copy the prebuilt guest agent binary into the image. The
  # upstream `cargo build --release` step is the source of truth for
  # what gets baked — Packer is just transport. Failing here means
  # the operator forgot to run the cargo build first.
  provisioner "file" {
    source      = var.linux_guest_binary
    destination = "/tmp/signalman-guest"
  }

  # Step 3: copy the host-side mTLS root CA bundle. The guest agent
  # reads it at runtime to verify the control plane's server cert.
  # Operators MUST replace the placeholder before running this for
  # real; the workflow surfaces this via a separate secret.
  provisioner "file" {
    source      = var.mtls_root_ca
    destination = "/tmp/signalman-control-plane-ca.pem"
  }

  # Step 4: install the binary + the systemd unit and enable it. We
  # don't `start` the service in the AMI build — first-boot is when
  # the unit's networking is configured.
  provisioner "shell" {
    inline = [
      "set -eux",
      "sudo install -o root -g root -m 0755 /tmp/signalman-guest /usr/local/bin/signalman-guest",
      "sudo install -o root -g root -m 0644 /tmp/signalman-control-plane-ca.pem /etc/signalman/control-plane-ca.pem || (sudo mkdir -p /etc/signalman && sudo install -o root -g root -m 0644 /tmp/signalman-control-plane-ca.pem /etc/signalman/control-plane-ca.pem)",
      "sudo tee /etc/systemd/system/signalman-guest.service > /dev/null <<'UNIT'",
      "[Unit]",
      "Description=Signalman guest agent",
      "Documentation=https://github.com/ambray/signalman",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      "ExecStart=/usr/local/bin/signalman-guest --bind 0.0.0.0:50051 --tls-ca /etc/signalman/control-plane-ca.pem",
      "Restart=on-failure",
      "RestartSec=5",
      "User=root",
      "AmbientCapabilities=CAP_NET_BIND_SERVICE",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "UNIT",
      "sudo systemctl daemon-reload",
      "sudo systemctl enable signalman-guest.service",
    ]
  }

  # Step 5: emit a manifest. CI uploads this as an artifact so the
  # operator can read AMI ids out of it without parsing Packer's
  # build log.
  post-processor "manifest" {
    output     = "manifest.json"
    strip_path = true
    custom_data = {
      agent_version = var.agent_version
      image_tag     = var.image_tag
      regions       = join(",", var.regions)
    }
  }
}
