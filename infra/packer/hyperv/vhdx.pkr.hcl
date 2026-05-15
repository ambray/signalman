# Generated for WS6 wave-3 carve-out #4 — Hyper-V VHDX golden-image
# template.
#
# Produces a Windows Server 2022 VHDX with the Signalman guest agent
# installed as a Windows service. The resulting VHDX path is what an
# operator passes to `signalman cloud provision --image-ref <path-or-url>`
# for the local Hyper-V backend; an out-of-band upload step (operator-
# owned, not part of this template) is required to push it to a blob
# share before remote machines can consume it.
#
# Requirements:
#   - Windows host with Hyper-V enabled (the hyperv-iso builder spawns
#     a Generation 2 VM during the build).
#   - A locally-available Windows Server 2022 ISO + sha256 checksum
#     (set via iso_url / iso_checksum variables; operator-provided
#     because the ISO is licensed, not redistributable).
#   - The prebuilt Windows guest agent at
#     `../../../guest/target/release/signalman-guest.exe`.
#
# This template is NOT exercised by CI — GitHub-hosted Linux runners
# cannot run Hyper-V, and GH-hosted Windows runners have Hyper-V
# disabled. Operators build it locally on a Windows workstation and
# upload the VHDX themselves.
#
# Invocation (local, Windows):
#   cd infra/packer/hyperv
#   packer init .
#   packer validate -var-file=../common/build.pkrvars.hcl `
#     -var "iso_url=C:/isos/windows-server-2022.iso" `
#     -var "iso_checksum=sha256:..." `
#     vhdx.pkr.hcl
#   packer build  -var-file=../common/build.pkrvars.hcl `
#     -var "iso_url=C:/isos/windows-server-2022.iso" `
#     -var "iso_checksum=sha256:..." `
#     vhdx.pkr.hcl

packer {
  required_version = ">= 1.10.0"
  required_plugins {
    hyperv = {
      source  = "github.com/hashicorp/hyperv"
      version = ">= 1.1.4"
    }
  }
}

# ── Variables ─────────────────────────────────────────────────────

variable "agent_version" {
  type        = string
  description = "Semantic version of the Signalman guest agent baked into the VHDX."
}

variable "image_tag" {
  type        = string
  description = "Free-form image tag stamped into the VHDX filename + manifest output."
}

variable "windows_guest_binary" {
  type        = string
  description = "Path to the prebuilt Windows signalman-guest.exe, relative to this template."
}

variable "mtls_root_ca" {
  type        = string
  description = "Path to the host-side mTLS root CA cert to bake into the image (relative to this template)."
}

variable "iso_url" {
  type        = string
  description = "Path or URL to the Windows Server 2022 install ISO. Operator-supplied (licensed media, not redistributable)."
}

variable "iso_checksum" {
  type        = string
  description = "Checksum of the ISO, in Packer's `<algo>:<hex>` form. e.g. 'sha256:abcd...'."
}

variable "vhdx_output_dir" {
  type        = string
  description = "Output directory for the built VHDX. Relative to this template."
  default     = "./output-vhdx"
}

variable "switch_name" {
  type        = string
  description = "Name of the Hyper-V virtual switch the build VM attaches to. The default 'Default Switch' ships with Windows 10/11/Server 2019+."
  default     = "Default Switch"
}

variable "memory_mb" {
  type        = number
  description = "RAM (MiB) for the build VM. Windows Server 2022 install needs at least 2048; 4096 is more reliable."
  default     = 4096
}

variable "cpus" {
  type        = number
  description = "vCPUs for the build VM."
  default     = 2
}

# ── Source ────────────────────────────────────────────────────────

source "hyperv-iso" "windows-server-2022" {
  description = "Windows Server 2022 base VHDX with the Signalman guest agent installed as a Windows service. Output VHDX is intended for upload to a blob/share for distribution; operator owns the upload step."

  iso_url      = var.iso_url
  iso_checksum = var.iso_checksum

  # ── Hyper-V VM shape ──────────────────────────────────────────
  generation         = 2
  enable_secure_boot = true
  cpus               = var.cpus
  memory             = var.memory_mb
  switch_name        = var.switch_name
  disk_size          = 40960 # 40 GiB; matches what the existing win11-base template uses for guest installs.

  # ── Output ────────────────────────────────────────────────────
  output_directory = var.vhdx_output_dir

  # ── WinRM (Packer's preferred Windows transport) ──────────────
  # The operator supplies an Autounattend.xml in `./http/` that
  # enables WinRM with the credentials below. We deliberately do NOT
  # check the autounattend file into this scaffolding — it embeds
  # the unattend admin password and licensing acceptance, which is
  # operator-specific. The README documents the contract.
  http_directory = "./http"
  boot_wait      = "5s"
  boot_command   = ["<enter>"]

  communicator   = "winrm"
  winrm_username = "Administrator"
  winrm_password = "S1gnalman!Build"
  winrm_timeout  = "60m"
  winrm_use_ssl  = false
  winrm_insecure = true

  shutdown_command = "shutdown /s /t 10 /f /d p:4:1 /c \"Packer Shutdown\""
}

# ── Build ─────────────────────────────────────────────────────────

build {
  name    = "signalman-guest-hyperv"
  sources = ["source.hyperv-iso.windows-server-2022"]

  # Step 1: copy the prebuilt Windows guest binary.
  provisioner "file" {
    source      = var.windows_guest_binary
    destination = "C:/Windows/Temp/signalman-guest.exe"
  }

  # Step 2: copy the host-side mTLS root CA bundle.
  provisioner "file" {
    source      = var.mtls_root_ca
    destination = "C:/Windows/Temp/signalman-control-plane-ca.pem"
  }

  # Step 3: install as a Windows service via sc.exe + place the CA
  # at a stable path that the guest agent reads at start time.
  provisioner "powershell" {
    inline = [
      "$ErrorActionPreference = 'Stop'",
      "New-Item -ItemType Directory -Force -Path 'C:/ProgramData/Signalman' | Out-Null",
      "Copy-Item 'C:/Windows/Temp/signalman-guest.exe' 'C:/ProgramData/Signalman/signalman-guest.exe' -Force",
      "Copy-Item 'C:/Windows/Temp/signalman-control-plane-ca.pem' 'C:/ProgramData/Signalman/control-plane-ca.pem' -Force",
      "sc.exe create SignalmanGuest binPath= '\"C:/ProgramData/Signalman/signalman-guest.exe\" --bind 0.0.0.0:50051 --tls-ca C:/ProgramData/Signalman/control-plane-ca.pem' start= delayed-auto DisplayName= 'Signalman Guest Agent'",
      "sc.exe description SignalmanGuest 'Signalman guest agent (https://github.com/ambray/signalman).'",
    ]
  }

  # Step 4: emit a manifest. Operators run a separate upload step to
  # publish the VHDX to a blob/share; that step reads `manifest.json`
  # for the local file path + the agent metadata.
  post-processor "manifest" {
    output     = "manifest.json"
    strip_path = true
    custom_data = {
      agent_version = var.agent_version
      image_tag     = var.image_tag
      output_dir    = var.vhdx_output_dir
    }
  }
}
