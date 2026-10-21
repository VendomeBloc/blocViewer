# Blocs de la salle

Static mobile-first site: zone map, boulder list with community grades, detail view with grade chart and "Beta" videos.
Hosted on GitHub Pages; grades are stored in Firebase Firestore (free Spark plan).

## Files

- `index.html`, `style.css`, `app.js`: the site itself
- `firebase-config.js`: Firebase project settings (public identifiers, not secrets)
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
  "photo": "photos/z1-01.jpg",
  "videos": ["https://www.youtube.com/watch?v=XXXXXXXXXXX"]
}
```

- `id`: unique; also the direct link (`https://.../#z1-01`) and the key of the grades in the database
- `color`: hex color; `colorName`: the name shown on the site
- `color2`: optional second hex color, shown as diagonal stripes
- `zone`: 1 to 4
- `photo`: path to the image. Empty or a bare folder (`photos/`) shows a colored placeholder
- `videos`: list of YouTube links (vertical videos / Shorts work). Use `[]` when there are none
- There is no `grade` field anymore: the level comes from the climbers' grades

## How grades work

- Each climber grades a boulder from 1 to 10 (whole numbers) and is asked for a name.
- The name is matched ignoring capitals and extra spaces. If it already graded the boulder, the climber chooses: update, delete, or use another name.
- A boulder's level is the average of its grades, shown with one decimal. With no grade yet it shows 10.0.
- The level filter and the list order use the average rounded to a whole number.
- The detail view shows a bar chart (one bar per grade, number of climbers); tapping a bar lists the names.

## Database (Firestore)

All grades live in one document, `grades/all`, so each page load costs a single read:

```
{ "z1-01": { "u_max": { "name": "Max", "grade": 7 }, ... }, ... }
```

Security rules (Firestore > Rules):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /grades/all {
      allow read: if true;
      allow create, update: if true;
      allow delete: if false;
    }
  }
}
```

Anyone with the site can add, change or remove grades (there are no accounts). The rules only prevent deleting the whole document from the site.

### Yearly reset

When you replace the boulders, give the new ones new ids (for example `2027-z1-01`) so old grades don't attach to new routes. To clean up, open the Firebase console > Firestore, and delete the `grades/all` document (the console can delete it; the site cannot).

## Adding a submitted video

Climbers tap "Proposer une vidéo" on a boulder, which opens WhatsApp with a prefilled message naming the boulder (including its `id`). They choose the group and paste their YouTube link. To publish it, add the link to that boulder's `videos` list in `data/boulders.json`.

## Run locally

Modules and `fetch` need a web server, so opening `index.html` directly will not work:

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Publish on GitHub Pages

Push everything to a public repo, then Settings > Pages > deploy from the main branch (root).
After a change, edit or upload the file on GitHub and commit; the site updates in about a minute.

Photo tip: about 1200 px wide, JPEG or WebP, 150-300 KB each.
