import os

from telethon import TelegramClient
from telethon.errors import (
    SessionPasswordNeededError,
    PhoneCodeInvalidError,
    PhoneCodeExpiredError,
    PasswordHashInvalidError,
)


class TelegramAuth:
    """Manages Telegram authentication for the webapp."""

    def __init__(self, api_id: int, api_hash: str, session_dir: str):
        self.api_id = api_id
        self.api_hash = api_hash
        self.session_path = os.path.join(session_dir, "webapp_session")
        self.client: TelegramClient | None = None
        self._phone_code_hash: str | None = None
        self._phone: str | None = None

    @property
    def is_logged_in(self) -> bool:
        return self.client is not None and self.client.is_connected()

    async def check_session(self) -> dict:
        """Check if an existing session is valid. Returns status dict."""
        if self.client and self.client.is_connected():
            me = await self.client.get_me()
            return {
                "logged_in": True,
                "user": {
                    "id": me.id,
                    "first_name": me.first_name or "",
                    "last_name": me.last_name or "",
                    "username": me.username or "",
                    "phone": me.phone or "",
                },
            }

        # Try loading existing session
        if os.path.exists(self.session_path + ".session"):
            try:
                self.client = TelegramClient(
                    self.session_path, self.api_id, self.api_hash
                )
                await self.client.connect()
                if await self.client.is_user_authorized():
                    me = await self.client.get_me()
                    return {
                        "logged_in": True,
                        "user": {
                            "id": me.id,
                            "first_name": me.first_name or "",
                            "last_name": me.last_name or "",
                            "username": me.username or "",
                            "phone": me.phone or "",
                        },
                    }
                else:
                    await self.client.disconnect()
                    self.client = None
            except Exception:
                if self.client:
                    try:
                        await self.client.disconnect()
                    except Exception:
                        pass
                self.client = None

        return {"logged_in": False}

    async def send_code(self, phone: str) -> dict:
        """Send verification code to phone number."""
        self._phone = phone

        if not self.client:
            self.client = TelegramClient(
                self.session_path, self.api_id, self.api_hash
            )

        if not self.client.is_connected():
            await self.client.connect()

        try:
            result = await self.client.send_code_request(phone)
            self._phone_code_hash = result.phone_code_hash
            return {"ok": True, "phone_code_hash": result.phone_code_hash}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def verify_code(self, phone: str, code: str) -> dict:
        """Verify the code sent to the phone."""
        if not self.client or not self.client.is_connected():
            return {"ok": False, "error": "No pending login. Send code first."}

        try:
            await self.client.sign_in(
                phone, code, phone_code_hash=self._phone_code_hash
            )
            me = await self.client.get_me()
            self._phone_code_hash = None
            return {
                "ok": True,
                "user": {
                    "id": me.id,
                    "first_name": me.first_name or "",
                    "username": me.username or "",
                    "phone": me.phone or "",
                },
            }
        except SessionPasswordNeededError:
            return {"ok": False, "needs_2fa": True}
        except PhoneCodeInvalidError:
            return {"ok": False, "error": "Invalid code. Try again."}
        except PhoneCodeExpiredError:
            return {"ok": False, "error": "Code expired. Request a new one."}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def verify_2fa(self, password: str) -> dict:
        """Verify 2FA password."""
        if not self.client or not self.client.is_connected():
            return {"ok": False, "error": "No pending login."}

        try:
            await self.client.sign_in(password=password)
            me = await self.client.get_me()
            return {
                "ok": True,
                "user": {
                    "id": me.id,
                    "first_name": me.first_name or "",
                    "username": me.username or "",
                    "phone": me.phone or "",
                },
            }
        except PasswordHashInvalidError:
            return {"ok": False, "error": "Wrong password."}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def logout(self) -> dict:
        """Log out and delete the session."""
        try:
            if self.client and self.client.is_connected():
                await self.client.log_out()
                await self.client.disconnect()
        except Exception:
            pass
        self.client = None

        # Delete session file
        for ext in [".session", ".session-journal"]:
            path = self.session_path + ext
            if os.path.exists(path):
                os.remove(path)

        return {"ok": True}
