# Blocs de la salle

Static mobile-first site: zone map, filterable boulder list, detail view with photo and "Beta" videos.

## Files

- `index.html`, `style.css`, `app.js`: the site itself
- `data/boulders.json`: the boulder list (edit this file)
- `data/zones.json`: the zone polygons and the "Tout" button (coordinates from the floor plan)
- `photos/`: one photo per boulder, named like the `photo` field

## Boulder fields

```json
{
  "id": "z1-01",
  "color": "#e53935",
  "color2": "#ffffff",
  "colorName": "Rouge et blanc",
  "zone": 1,
  "grade": 2,
  "photo": "photos/z1-01.jpg",
  "videos": ["https://www.youtube.com/watch?v=XXXXXXXXXXX"]
}
```

- `id`: unique; also the direct link (`https://.../#z1-01`)
- `color`: hex color; `colorName`: the name shown on the site
- `color2`: optional second hex color, shown as diagonal stripes. Leave the field out for a single-color boulder
- `zone`: 1 to 4
- `grade`: 1 to 10
- `videos`: list of YouTube links (vertical videos / Shorts work). Use `[]` when there are none
- A missing photo shows a placeholder in the boulder's color(s)

## Adding a submitted video

Climbers tap "Proposer une vidéo" on a boulder, which opens WhatsApp with a prefilled message
naming the boulder (including its `id`). They choose the group and paste their YouTube link.
To publish it, add the link to that boulder's `videos` list in `data/boulders.json`.

## Run locally

`fetch` needs a web server, so opening `index.html` directly will not work:

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Publish on GitHub Pages

Push everything to a public repo, then Settings > Pages > deploy from the main branch (root).
After a change, edit the file on GitHub and commit; the site updates in about a minute.

Photo tip: about 1200 px wide, JPEG or WebP, 150-300 KB each.
