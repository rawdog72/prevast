# Working in Prevast Open Server

Follow [CONTRIBUTING.md](CONTRIBUTING.md); it applies to coding agents as
well. In short:

- Run commands from the repository root.
- The C++ server is authoritative; the client renders state and sends input.
- Change the protocol on both sides together (`apps/server/src/network/opcodes.h`
  and `apps/client/src/net/`).
- Edit content only in `data/`, keeping IDs, include order and keys stable.
- Never commit original Devast.io assets or text; they belong in the ignored
  `original-assets/` folder.
- Run the checks CONTRIBUTING.md lists for what you changed, and
  `npm run release:audit` before pushing.
