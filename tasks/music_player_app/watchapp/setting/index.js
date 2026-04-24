AppSettingsPage({
  state: { loaded: false },

  build(props) {
    const current = this._read(props);

    return View({ style: { padding: 16 } }, [
      Text({ style: { fontSize: 22, fontWeight: 'bold', marginBottom: 6 } }, 'Music Lyrics — setup'),
      Text({ style: { fontSize: 13, color: '#555', marginBottom: 14 } },
        'Enter the URL your Mac / server exposes. Example: http://192.168.1.23:8080 (no trailing slash). Token is optional unless WEBAPP_NP_TOKEN is set on the server.'),

      Section({ title: 'Server URL' }, [
        TextInput({
          label: 'Base URL',
          value: current.baseUrl,
          placeholder: 'http://192.168.1.23:8080',
          onChange: (v) => this._save(props, { ...current, baseUrl: v.trim() }),
        }),
      ]),

      Section({ title: 'Token (optional)' }, [
        TextInput({
          label: 'X-NP-Token',
          value: current.token,
          placeholder: '(leave empty)',
          onChange: (v) => this._save(props, { ...current, token: v.trim() }),
        }),
      ]),

      Text({ style: { fontSize: 12, color: '#888', marginTop: 18 } },
        'Tip: your Mac and iPhone must be on the same Wi-Fi. Use `ifconfig | grep inet` on the Mac to find the LAN IP.'),
    ]);
  },

  _read(props) {
    try {
      const raw = props.settingsStorage.getItem('music_lyrics_settings');
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { baseUrl: '', token: '' };
  },

  _save(props, next) {
    props.settingsStorage.setItem('music_lyrics_settings', JSON.stringify(next));
  },
});
