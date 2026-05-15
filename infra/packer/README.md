# Signalman Packer golden images

Packer templates that bake the Signalman guest agent into immutable
images for the AWS, Azure, and Hyper-V backends. The output of each
template is what the host's `CloudInstanceConfig.image_ref` points at
(`host/src/cloud/types.ts`):

- **AWS** → AMI id (e.g. `ami-0abc1234`).
- **Azure** → managed-image resource id
  (`/subscriptions/.../providers/Microsoft.Compute/images/...`).
- **Hyper-V** → local VHDX path or URL of an upload destination.

The cross-backend invariant is the **tag set** stamped on every
Packer-built artifact: `signalman-managed=true` plus a
`signalman-org`, `signalman-agent-version`, `signalman-image-tag`,
and `signalman-image-purpose=golden-image`. The cost-reaper
(`host/src/cloud/reaper.ts`) filters cloud instances by the
`signalman-managed` key, so any instance launched from a Packer-built
AMI/managed-image inherits the marker automatically through whatever
launch path the operator wires up.

## What gets installed in the image

1. Latest base-image security patches via `apt-get upgrade` (Linux)
   or whatever Windows Update produces during sysprep (Windows).
2. The prebuilt `signalman-guest` binary at
   `/usr/local/bin/signalman-guest` (Linux) or
   `C:/ProgramData/Signalman/signalman-guest.exe` (Windows).
3. A persistent mTLS root CA bundle at
   `/etc/signalman/control-plane-ca.pem` (Linux) or
   `C:/ProgramData/Signalman/control-plane-ca.pem` (Windows). The
   guest agent reads this on start to verify the control plane's
   server cert.
4. A service unit that runs the guest agent on boot:
   `signalman-guest.service` (systemd) or the `SignalmanGuest`
   Windows service.

The guest binary is **not** built by Packer. The CI workflow and the
local-build documentation both assume the binary is already on disk
at `../../../guest/target/release/signalman-guest` (or `.exe`),
produced by `cargo build --release --bin signalman-guest`.

## Required tooling

- **Packer**: 1.10.0 or newer. The HCL2 features used here
  (`required_plugins` blocks, typed variables, `sensitive = true`)
  are 1.10+. Install: <https://developer.hashicorp.com/packer/install>.
- **AWS template**: AWS credentials with `EC2:RunInstances`,
  `EC2:CreateImage`, `EC2:CreateTags`, `EC2:DescribeImages`,
  `EC2:DeleteSnapshot`. The credentials chain is the standard AWS
  one (env vars, profile, instance profile); the template does not
  pass them in directly.
- **Azure template**: a service principal with `Contributor` on the
  target resource group (it must contain both the build VM and the
  output managed image), or an `az login` session with equivalent
  rights. The resource group itself must pre-exist; the builder
  does not create it.
- **Hyper-V template**: a Windows host (10/11 Pro or Server) with
  the Hyper-V feature enabled, plus a Windows Server 2022 install
  ISO that the operator owns. The default Hyper-V virtual switch
  needs to grant the build VM internet access for any post-install
  Windows Update bootstrap.

## Local invocation

The variable defaults live in `common/build.pkrvars.hcl`. Override
the per-environment ones at the `packer build` invocation rather
than editing the shared defaults.

```sh
# AWS — single region
cd infra/packer/aws
packer init .
packer validate -var-file=../common/build.pkrvars.hcl ami.pkr.hcl
packer build  -var-file=../common/build.pkrvars.hcl \
  -var 'regions=["us-east-1"]' \
  ami.pkr.hcl
```

```sh
# Azure — needs subscription + resource group
cd infra/packer/azure
packer init .
packer validate -var-file=../common/build.pkrvars.hcl managed-image.pkr.hcl
packer build  -var-file=../common/build.pkrvars.hcl \
  -var 'subscription_id=...' \
  -var 'managed_image_resource_group=signalman-golden-images' \
  -var 'location=eastus' \
  managed-image.pkr.hcl
```

```powershell
# Hyper-V — Windows host only
cd infra/packer/hyperv
packer init .
packer validate -var-file=../common/build.pkrvars.hcl `
  -var "iso_url=C:/isos/windows-server-2022.iso" `
  -var "iso_checksum=sha256:..." `
  vhdx.pkr.hcl
packer build  -var-file=../common/build.pkrvars.hcl `
  -var "iso_url=C:/isos/windows-server-2022.iso" `
  -var "iso_checksum=sha256:..." `
  vhdx.pkr.hcl
```

Each build emits a `manifest.json` next to the template. CI uploads
that file as an artifact; local operators read it to find the AMI
id / managed-image resource id / VHDX path to feed into config.

## How the image-refs flow back into operator config

The manifest is JSON shaped per Packer's
[`manifest`](https://developer.hashicorp.com/packer/docs/post-processors/manifest)
post-processor. The relevant field is `builds[].artifact_id`, which
holds the AMI id (`region:ami-id` for the amazon-ebs builder) or the
managed-image resource id (Azure). Paste that value into:

```
signalman cloud provision \
  --backend aws \
  --region us-east-1 \
  --image-ref ami-0abc1234 \
  ...
```

The host treats the image ref as an opaque string
(`host/src/cloud/types.ts`, `CloudInstanceConfig.image_ref`); the
vendor backend interprets it.

## What the cost-reaper expects

Every Packer-built image carries `signalman-managed=true` in its
vendor tags. AMIs and Azure managed images propagate this tag to the
EC2 instances / Azure VMs launched from them via the standard
inheritance path — but the operator-side launch tooling
(`signalman cloud provision`) also re-stamps the tag on the launched
instance directly. That means the reaper sees the marker regardless
of which launch path created the workload.

The reaper does NOT inspect the AMI tags; it filters running
instances by tag. The AMI/managed-image tags are present mainly so
an operator can identify "which Signalman build produced this
artifact" months later.

## Known limitations

- **No cross-region AMI copy.** The AWS template builds one AMI per
  region in the `regions` list, but does not use Packer's
  `ami_regions` cross-region copy (that path is async, lags the
  manifest, and complicates the per-region AMI id map). Operators
  who need many regions either run the build N times (cheap) or
  bolt an `aws ec2 copy-image` script onto the workflow.
- **No Azure regional replication.** The managed image lives in the
  region the build VM ran in. Replicating across regions is a
  Shared Image Gallery concern, which is out of scope for the
  scaffolding; operators do the manual copy via `az image copy` or
  promote the artifact to a SIG version themselves.
- **No image signing yet.** The ROADMAP entry (line ~1051) calls
  out signing-with-the-release-key as the eventual end state. The
  scaffolding emits manifests; signing them is a follow-up.
- **No vm_lineage_hash backfill.** The host's `vm_lineage_hash`
  (v0.3.0-3) is computed from the template+version+OS+installed[]
  tuple. The Packer build doesn't update the artifact catalog with
  that tuple — an operator-side step does.
- **CI does not run the Hyper-V build.** GitHub Actions does not
  expose nested-virtualisation Windows runners; the Hyper-V VHDX
  build is documented as an operator-local procedure. The workflow
  comments call this out explicitly.
- **WinRM credentials are placeholders.** The Hyper-V template ships
  with a hard-coded build-time admin password used only to provision
  the build VM (it never reaches the captured image because the
  capture deprovisions and sysprep runs). Operators who want a
  rotating credential should set it via `-var` at build time.
