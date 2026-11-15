(async () => {
  const element = id => document.getElementById(id);
  const error = element('error');
  let timer;
  const show = session => {
    element('input-panel').hidden = true;
    element('session-panel').hidden = false;
    element('status').textContent = session.message;
    element('expires').textContent = `Temporary settings expire at ${new Date(session.expiresAt).toLocaleTimeString()}.`;
    element('phone-link').href = session.url;
    if (session.qr) { element('qr').hidden = false; element('qr').src = session.qr; }
  };
  try {
    const config = await homebridge.getPluginConfig();
    if (!config.length) await homebridge.updatePluginConfig([{ platform: 'MyQReadOnly', name: 'myQ', enableControl: false }]);
    homebridge.showSchemaForm();
    const options = await homebridge.request('/setup/options');
    for (const address of options.addresses) {
      const option = document.createElement('option');
      option.value = option.textContent = address;
      element('address').append(option);
    }
    if (!options.addresses.length) throw new Error('No home-network address found. Homebridge must be reachable from your iPhone over your private LAN.');
    const poll = async () => {
      try {
        const session = await homebridge.request('/setup/status');
        if (session.state !== 'idle') show(session);
      } catch { error.textContent = 'Setup connection lost. Remove the temporary profile on your iPhone.'; }
    };
    await poll();
    timer = setInterval(poll, 2500);
    element('start').onclick = async () => {
      error.textContent = '';
      element('start').disabled = true;
      try {
        await homebridge.savePluginConfig();
        const session = await homebridge.request('/setup/start', {
          address: element('address').value, ssid: element('ssid').value,
          password: element('wifi-password').value,
        });
        element('wifi-password').value = '';
        show(session);
        clearInterval(timer);
        timer = setInterval(poll, 2500);
      } catch (e) { error.textContent = e.message || 'Setup could not start.'; }
      finally { element('start').disabled = false; }
    };
    element('finish').onclick = async () => {
      try {
        await homebridge.request('/setup/finish');
        clearInterval(timer);
        element('session-panel').hidden = true;
        element('input-panel').hidden = false;
        error.textContent = '';
        homebridge.toast.success('Setup ended. Saved credentials will be picked up automatically; restart the myQ child bridge if you just added the plugin.');
      } catch { error.textContent = 'Unable to finish setup. Remove the temporary iPhone profile; the session also expires automatically.'; }
    };
  } catch (e) { error.textContent = e.message || 'Unable to load myQ setup.'; }
  finally { homebridge.hideSpinner(); }
})();
