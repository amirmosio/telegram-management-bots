AppSettingsPage({
  build(props) {
    const token = props.settingsStorage.getItem('token') || '';

    return Section({ style: { padding: 16 } }, [
      View({ style: { marginBottom: 8 } }, [
        Text({ style: { fontSize: 20, fontWeight: 'bold' } }, 'Music Lyrics'),
      ]),
      View({ style: { marginBottom: 16 } }, [
        Text({ style: { fontSize: 13, color: '#555' } },
          "Works out of the box for the owner's Telegram account. If you use a different Telegram account, paste its token (from the ⌚ Watch setup button in the web app)."),
      ]),
      View({ style: { marginBottom: 8 } }, [
        Text({ style: { fontSize: 14, marginBottom: 6 } }, 'Token (optional override)'),
        TextInput({
          placeholder: 'Leave empty to use default',
          value: token,
          onChange: (v) => props.settingsStorage.setItem('token', (v || '').trim()),
        }),
      ]),
    ]);
  },
});
