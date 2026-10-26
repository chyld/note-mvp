# Margin

A small self-hosted notes app for a handful of users. Notes are plain text with a light
formatting syntax, shown either raw or rendered (and editable in both). There's no database:
everything is stored in files.

## Install

You need Docker with Docker Compose.

```sh
git clone https://github.com/chyld/note-mvp.git margin
cd margin
docker compose up -d --build
```

Margin is now running on port **5555** on all network interfaces: open `http://<host>:5555`.

### Create users

Users are created from the command line. You'll be asked for a password:

```sh
docker compose exec margin margin-user add alice
```

Other commands:

```sh
docker compose exec margin margin-user list
docker compose exec margin margin-user passwd alice
docker compose exec margin margin-user remove alice   # their notes stay on disk
```

Changes take effect right away, without a restart.

### Update

```sh
git pull
docker compose up -d --build
```

## Data

Everything lives in `./data` next to `compose.yaml`:

```
data/
  users.json                    usernames and password hashes
  sessions.json                 login sessions
  notes/<user>/<note id>/
    note.md                     the note's text
    meta.json                   tags, created/modified times, trash state
    <id>.png                    pasted screenshots
```

To back up Margin, copy the `data` folder.

The container runs as UID/GID 1000 so the files in `./data` belong to your user. If your
user has a different ID, set it when starting Margin:

```sh
MARGIN_UID=$(id -u) MARGIN_GID=$(id -g) docker compose up -d
```

## Security

Margin uses **plain HTTP**. Your password and session cookie are sent unencrypted, which is
fine on a trusted home network but not on the open internet. If you want to reach Margin
from outside your network, put it behind a reverse proxy with TLS (such as Caddy or nginx),
or use a VPN like Tailscale.

Logins last 30 days and are renewed while you use Margin. **Log out** ends a session.

## Using Margin

- **Notes**: a note's first line is its title. **+ New note** creates one (it gets the tag
  you're filtering by, if any). Empty notes are fine.
- **Saving**: notes are saved only when you press **Save** or **Ctrl+S**. The Save button is
  green when saved, amber when there are unsaved changes, and red if saving failed. The browser
  warns you before unsaved changes would be lost. If a note is open in two tabs, the last save
  wins.
- **Render / Raw**: Render mode shows the formatting; Raw mode shows the syntax. You can edit
  in both. **Ctrl+E** switches between them.
- **Formatting**: select text and a popup appears: **B**, **U**, **</>** (code),
  **Section**, **Clear formatting**, **Remove color**, and 24 highlight colors. Click an
  option, or use the arrow keys and **Enter**. **Esc** closes the popup.
- **Tags**: add tags in the bar above the note (lowercase a-z and 0-9). Tags save immediately.
  The dropdown at the top of the sidebar filters notes by tag.
- **Search**: the search box matches the text of your notes and works together with the tag
  filter.
- **Screenshots**: paste a PNG screenshot into a note. Only PNGs are accepted, with no size
  limit. Screenshots are kept even if you remove them from the note.
- **Trash**: **Trash** moves a note to the trash. Open the trash from the bottom of the
  sidebar to restore notes or delete them forever. Nothing is deleted until you do.
- **Links**: the address bar always links to what you're looking at:
  `http://<host>:5555/?note=k3x9q2mf` for a note or `http://<host>:5555/?tag=work` for a tag.
  If you're logged out you'll log in first; a note or tag that doesn't exist gives a 404.

## Formatting syntax

| Write | Shows as |
|---|---|
| `=={green}wrist exercises==` | text highlighted in light green |
| `=={amber-deep}computer that yells at you==` | text highlighted in deep amber |
| `=={b}together==` | bold |
| `=={u}duplicates==` | underlined |
| `=={lime+b+u}yearbook==` | light lime, bold and underlined |
| `` `inline code` `` | inline code |
| `## {green-deep} Notes App` | a collapsible section heading |
| `![](a7p2xq9d.png)` | a pasted screenshot |

Code blocks are fenced with three backticks on their own lines:

````
```
const x = 1;
```
````

Inside code, nothing is formatted. Tab and Shift+Tab indent by two spaces inside code
blocks, and in render mode hovering a block shows a **Copy** button.

Highlight options are joined with `+`: at most one color, plus `b` and/or `u`. Formatting
only applies when the syntax is exactly right, so a stray `==` stays plain text.

**Colors**: `red`, `orange`, `amber`, `lime`, `green`, `mint`, `teal`, `sky`, `blue`,
`violet`, `fuchsia`, `pink`, each also as `<color>-deep`.

**Sections** start at a `## {color} Heading` line and run to the next section heading or the
end of the note. In render mode, click the ⌄ to collapse or expand one. Collapsed sections
are remembered in your browser. **Section** in the popup turns the selected line into a
`## {blue-deep}` heading, or a heading back into a plain line. To change a section's color,
select text in its heading and pick a color: the heading and its bar always share the section's
color, so highlight colors inside a heading aren't shown (bold and underline still are).

## Development

```sh
npm install
npm run watch                              # rebuild the client on change
DATA_DIR=./dev-data PORT=5556 npm start    # in another terminal
MARGIN_PASSWORD=secret DATA_DIR=./dev-data node cli.js add dev
```

The server is Node and Express (`server/`). The editor is CodeMirror 6 (`client/`), bundled
with esbuild. The note format parser in `shared/format.js` is used by both.
