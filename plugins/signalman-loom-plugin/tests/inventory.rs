//! Integration test: confirm the plugin actually submits itself into the
//! Loom trusted-plugin inventory at link time. This is what makes Loom
//! discover the plugin without an explicit handshake.

use loom_plugin_api::inventory_trusted_plugins;

#[test]
fn signalman_plugin_appears_in_loom_inventory() {
    let plugins = inventory_trusted_plugins();
    let ids: Vec<String> = plugins
        .iter()
        .map(|p| p.manifest().id.to_string())
        .collect();
    assert!(
        ids.iter().any(|id| id == "signalman-loom-plugin"),
        "signalman-loom-plugin not registered via inventory; got {:?}",
        ids
    );
}

#[test]
fn signalman_plugin_initialize_returns_seven_mcp_tools() {
    // P5.1 shipped six verbs; P5.4 added `loom.signalman.form_descriptor`
    // for descriptor-backed TUI forms — total seven.
    //
    // We can't construct a real PluginContext here (it requires concrete
    // services), so we only verify the registration count surface via the
    // public re-export.
    use signalman_loom_plugin::handlers;
    let regs = handlers::all_tool_registrations();
    assert_eq!(regs.len(), 7);
    for reg in &regs {
        assert!(
            reg.name.starts_with("loom.signalman."),
            "tool name must use loom.signalman.* namespace; got {}",
            reg.name
        );
        assert!(
            !reg.description.is_empty(),
            "tool {} missing description",
            reg.name
        );
    }
}
