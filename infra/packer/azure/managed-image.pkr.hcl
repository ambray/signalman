# Generated for WS6 wave-3 carve-out #4 — Azure managed-image
# golden-image template.
#
# Produces an Azure managed image per requested location with the
# Signalman guest agent pre-installed as a systemd unit. The resulting
# resource id (e.g.
# `/subscriptions/.../resourceGroups/.../providers/Microsoft.Compute/images/...`)
# is what an operator passes to
# `signalman cloud provision --image-ref ...` (CloudInstanceConfig.image_ref).
#
# Build context:
#   Same as the AWS template — the build runs from
#   `infra/packer/azure/` and reads the prebuilt Linux guest binary
#   from the workspace's `guest/target/release/` directory.
#
# Auth:
#   The azure-arm builder takes either a service-principal triple
#   (client_id / client_secret / tenant_id) or an Azure CLI session.
#   CI uses the SP triple (passed in as variables piped from secrets);
#   local operators commonly rely on `az login`.
#
# Invocation (local):
#   cd infra/packer/azure
#   packer init .
#   packer validate -var-file=../common/build.pkrvars.hcl managed-image.pkr.hcl
#   packer build  -var-file=../common/build.pkrvars.hcl managed-image.pkr.hcl

packer {
  required_version = ">= 1.10.0"
  required_plugins {
    azure = {
      source  = "github.com/hashicorp/azure"
      version = ">= 2.0.0"
    }
  }
}

# ── Variables ─────────────────────────────────────────────────────

variable "agent_version" {
  type        = string
  description = "Semantic version of the Signalman guest agent baked into the image."
}

variable "image_tag" {
  type        = string
  description = "Free-form image tag stamped into image tags + manifest output (git sha in CI)."
}

variable "linux_guest_binary" {
  type        = string
  description = "Path to the prebuilt Linux signalman-guest binary, relative to this template."
}

variable "mtls_root_ca" {
  type        = string
  description = "Path to the host-side mTLS root CA cert to bake into the image (relative to this template)."
}

variable "subscription_id" {
  type        = string
  description = "Azure subscription id that owns the resource group + managed image."
}

variable "client_id" {
  type        = string
  description = "Service-principal client id. When empty the azure-arm builder falls back to the Azure CLI session."
  default     = ""
}

variable "client_secret" {
  type        = string
  description = "Service-principal client secret. Sensitive."
  sensitive   = true
  default     = ""
}

variable "tenant_id" {
  type        = string
  description = "Azure AD tenant id. Required when authenticating via service principal."
  default     = ""
}

variable "managed_image_resource_group" {
  type        = string
  description = "Resource group that holds the managed image output. Must pre-exist; the builder does not create it."
}

variable "location" {
  type        = string
  description = "Azure location (region) for the managed image. e.g. 'eastus', 'westeurope'."
  default     = "eastus"
}

variable "vm_size" {
  type        = string
  description = "VM size used for the build VM. Standard_D2s_v3 balances cost and apt-update speed."
  default     = "Standard_D2s_v3"
}

# ── Source ────────────────────────────────────────────────────────

source "azure-arm" "ubuntu-22-04" {
  description = "Ubuntu 22.04 LTS Azure managed image with the Signalman guest agent installed as a systemd unit. Tagged signalman-managed=true so the cost-reaper recognises Packer-built images."

  # ── Auth ──────────────────────────────────────────────────────
  subscription_id = var.subscription_id
  client_id       = var.client_id
  client_secret   = var.client_secret
  tenant_id       = var.tenant_id

  # ── Output ────────────────────────────────────────────────────
  managed_image_name                = "signalman-guest-${var.agent_version}-${var.image_tag}"
  managed_image_resource_group_name = var.managed_image_resource_group

  # ── Base image ────────────────────────────────────────────────
  # Canonical's Azure 22.04 LTS gen2. Pinning by publisher + offer +
  # sku rather than a frozen version id lets monthly Packer runs
  # pick up upstream security patches.
  os_type         = "Linux"
  image_publisher = "Canonical"
  image_offer     = "0001-com-ubuntu-server-jammy"
  image_sku       = "22_04-lts-gen2"
  image_version   = "latest"

  # ── Build VM ──────────────────────────────────────────────────
  location = var.location
  vm_size  = var.vm_size

  # ── Tags ──────────────────────────────────────────────────────
  # Match the AWS template's tag invariant so the cost-reaper sees
  # the same key/value pairs across vendors.
  azure_tags = {
    "signalman-managed"        = "true"
    "signalman-org"            = "signalman-build"
    "signalman-agent-version"  = var.agent_version
    "signalman-image-tag"      = var.image_tag
    "signalman-image-purpose"  = "golden-image"
  }
}

# ── Build ─────────────────────────────────────────────────────────

build {
  name    = "signalman-guest-azure"
  sources = ["source.azure-arm.ubuntu-22-04"]

  provisioner "shell" {
    inline = [
      "set -eux",
      "sudo cloud-init status --wait || true",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get update -y",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates",
    ]
  }

  provisioner "file" {
    source      = var.linux_guest_binary
    destination = "/tmp/signalman-guest"
  }

  provisioner "file" {
    source      = var.mtls_root_ca
    destination = "/tmp/signalman-control-plane-ca.pem"
  }

  provisioner "shell" {
    inline = [
      "set -eux",
      "sudo install -o root -g root -m 0755 /tmp/signalman-guest /usr/local/bin/signalman-guest",
      "sudo mkdir -p /etc/signalman",
      "sudo install -o root -g root -m 0644 /tmp/signalman-control-plane-ca.pem /etc/signalman/control-plane-ca.pem",
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

  # Azure managed-image builds require deprovisioning the agent so the
  # captured image is reusable across VMs. waagent -deprovision+user
  # is the documented prepare-for-capture sequence.
  provisioner "shell" {
    execute_command = "chmod +x {{ .Path }}; {{ .Vars }} sudo -E sh '{{ .Path }}'"
    inline_shebang  = "/bin/sh -x"
    inline = [
      "/usr/sbin/waagent -force -deprovision+user",
      "export HISTSIZE=0",
      "sync",
    ]
  }

  post-processor "manifest" {
    output     = "manifest.json"
    strip_path = true
    custom_data = {
      agent_version   = var.agent_version
      image_tag       = var.image_tag
      location        = var.location
      resource_group  = var.managed_image_resource_group
    }
  }
}
