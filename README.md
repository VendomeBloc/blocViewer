# Blocs de la salle

Static mobile-first site: zone map, filterable boulder list, detail view with photo and YouTube video.

## Files

- `index.html`, `style.css`, `app.js`: the site itself
- `data/boulders.json`: the boulder list (edit this file)
- `data/zones.json`: the four zone polygons (coordinates from the floor plan)
- `photos/`: one photo per boulder, named like the `photo` field

## Boulder fields

```json
{
  "id": "z1-01",
  "color": "#e53935",
  "colorName": "Rouge",
  "zone": 1,
  "grade": 2,
  "photo": "photos/z1-01.jpg",
  "video": "https://www.youtube.com/watch?v=XXXXXXXXXXX"
}
```

- `id`: unique; also the direct link (`https://.../#z1-01`)
- `zone`: 1 to 4
- `grade`: 1 to 10
- `video`: optional, leave `""` when there is none
- A missing photo shows a placeholder in the boulder's color

## Run locally

`fetch` needs a web server, so opening `index.html` directly will not work:

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Publish on GitHub Pages

Push everything to a public repo, then Settings > Pages > deploy from the main branch (root).

Photo tip: about 1200 px wide, JPEG or WebP, 150-300 KB each.
