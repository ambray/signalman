# Service Backend Smoke

Run a command through the selected hypervisor backend and copy its output back through the same backend.

```tool
vm_run_command:
  vm: endpoint-1
  command: powershell.exe
  args:
    - -NoProfile
    - -Command
    - "$value = Get-Content -Raw C:\\SignalmanSmoke\\input.txt; Set-Content -Path C:\\SignalmanSmoke\\output.txt -Value \"service-backend-smoke:$value\"; Get-Content -Raw C:\\SignalmanSmoke\\output.txt"
  timeout_ms: 60000
```

```tool
vm_copy_file:
  vm: endpoint-1
  direction: from_vm
  guest_path: C:\SignalmanSmoke\output.txt
  host_path: ./output/service-backend-smoke/output.txt
```
