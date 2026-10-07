# Original assets

Prevast Open Server draws the original Devast.io images and plays its sounds,
but **does not include them**. They belong to their owners and are not covered
by this project's license, so they are never committed here.

If you have your own copy, put it in this folder:

```text
original-assets/
  img/      the original image files (alert0_0.png, wood-button-out.png, ...)
  audio/    the original sound files (craft.mp3, title.mp3, ...)
```

Then check it:

```bash
npm run assets:check
```

It lists files that are missing or that differ from the version this project
was made for. `manifest.json` names every expected file with its size and
SHA-256; it holds no image or sound data.

Without these files everything still builds, the tests pass and the game runs,
with blanks where sprites and sounds would be. The project's own art lives in
`apps/client/public/img` and is served first, so a file of the same name here
is ignored.

Everything in this folder except this README and `manifest.json` is ignored
by Git. Do not force-add original files: `npm run check` fails when one is
committed.
