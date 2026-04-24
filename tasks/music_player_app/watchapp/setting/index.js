AppSettingsPage({
  build(props) {
    const baseUrl = props.settingsStorage.getItem('baseUrl') || '';
    const token = props.settingsStorage.getItem('token') || '';

    return Section({ style: { padding: 16 } }, [
      View({ style: { marginBottom: 8 } }, [
        Text({ style: { fontSize: 20, fontWeight: 'bold' } }, 'Music Lyrics — setup'),
      ]),
      View({ style: { marginBottom: 16 } }, [
        Text({ style: { fontSize: 13, color: '#555' } },
          'Server URL is your music-player domain. Token comes from the web app → Watch setup.'),
      ]),

      View({ style: { marginBottom: 12 } }, [
        Text({ style: { fontSize: 14, marginBottom: 6 } }, 'Server URL'),
        TextInput({
          placeholder: 'https://telemusic.duckdns.org',
          value: baseUrl,
          onChange: (v) => props.settingsStorage.setItem('baseUrl', (v || '').trim()),
        }),
      ]),

      View({ style: { marginBottom: 16 } }, [
        Text({ style: { fontSize: 14, marginBottom: 6 } }, 'Token'),
        TextInput({
          placeholder: 'Paste token from web app',
          value: token,
          onChange: (v) => props.settingsStorage.setItem('token', (v || '').trim()),
        }),
      ]),

      View({}, [
        Text({ style: { fontSize: 12, color: '#888' } },
          'The token comes from the ⌚ Watch setup button in the web app. Different Telegram accounts have different tokens.'),
      ]),
    ]);
  },
});
