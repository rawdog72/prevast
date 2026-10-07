# In-game chat

The bottom-left chat panel has Local, Global and Clan channels, with Admin available to staff. The Messages selector holds private conversations and the read-only Activity log. Open a conversation and use Pin to keep it on the tab strip. NPC conversations have their own labeled tab and clickable reply keywords.

Enter opens chat, sends a message and returns to gameplay. Escape leaves typing and preserves the draft. Each conversation keeps its own draft and reading position. Scroll up to read history; the new-message button returns to the latest lines. Messages are marked read only at the bottom of an expanded chat in the foreground.

- `/w <name or #id> [message]`: open or send a whisper. Quote names containing spaces. Duplicate names require an ID.
- `/r [message]`: reply to the last incoming whisper.
- `/help`: show chat help. Existing `!priv=`, `!block=`, `!unblock=` and staff commands still work.
- Tab completes a player name after `/w`, `!priv=` or `@`. Arrow keys select a suggestion; otherwise Up/Down recalls sent input. Ctrl+Tab switches conversations.
- Click a player name for actions, including Message, Block and Copy text. Double-click opens a whisper; right-click also opens the actions.

The gear opens chat-specific settings: panel width/height, text size/font, opacity, timestamps, staying in typing mode after sending, local speech bubbles, and each channel's notification mode and sound. Drag the panel's bottom-right corner to resize it. Appearance and notification settings persist locally; conversations, pins and drafts are session-only.

Drafts for ordinary messages are retained until the server echoes the send. Rejections and unconfirmed sends keep the draft; a timeout never automatically resends. The capacity indicator matches the current server limit of 200 UTF-8 bytes, excluding whisper command syntax. Unicode characters can consume multiple bytes.

Local speech bubbles wrap to at most three lines and last five to eight seconds depending on message length. Longer text is shortened visually with an ellipsis; the chat log retains the full message.
