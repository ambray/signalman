# Service Backend Smoke

Run a command through the selected hypervisor backend and copy its output back through the same backend.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell.exe
  args:
    - -NoProfile
    - -EncodedCommand
    - JAB2AGEAbAB1AGUAIAA9ACAARwBlAHQALQBDAG8AbgB0AGUAbgB0ACAALQBSAGEAdwAgAEMAOgBcAFMAaQBnAG4AYQBsAG0AYQBuAFMAbQBvAGsAZQBcAGkAbgBwAHUAdAAuAHQAeAB0ADsAIABTAGUAdAAtAEMAbwBuAHQAZQBuAHQAIAAtAFAAYQB0AGgAIABDADoAXABTAGkAZwBuAGEAbABtAGEAbgBTAG0AbwBrAGUAXABvAHUAdABwAHUAdAAuAHQAeAB0ACAALQBWAGEAbAB1AGUAIAAiAHMAZQByAHYAaQBjAGUALQBiAGEAYwBrAGUAbgBkAC0AcwBtAG8AawBlADoAJAB2AGEAbAB1AGUAIgA7ACAARwBlAHQALQBDAG8AbgB0AGUAbgB0ACAALQBSAGEAdwAgAEMAOgBcAFMAaQBnAG4AYQBsAG0AYQBuAFMAbQBvAGsAZQBcAG8AdQB0AHAAdQB0AC4AdAB4AHQA
  timeout_ms: 60000
```

```tool
vm_copy_file:
  vm: endpoint-1
  direction: from_vm
  guest_path: C:\SignalmanSmoke\output.txt
  host_path: ./output/service-backend-smoke/output.txt
```
