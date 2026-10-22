# Blocs de la salle

Static mobile-first site: zone map, boulder list with French grades, detail view with completions, climbers' opinions on the grade and "Beta" videos.
Hosted on GitHub Pages. Boulders and climbers' records are stored in Firebase Firestore (free Spark plan).

## Files

- `index.html`, `style.css`, `app.js`: the site itself
- `firebase-config.js`: Firebase project settings (public identifiers, not secrets)
- `data/boulders.json`: the boulder list. It is the starting data (see "Boulders"), and a backup
- `data/zones.json`: the zone polygons and the "Tout" button (coordinates from the floor plan)
- `photos/`: the photos, referenced by the `photo` field of each boulder

## Boulders

The boulder list lives in Firestore (`boulders/all`). The first time the site loads and finds no such document, it creates it from `data/boulders.json`. If the database cannot be reached, the site falls back to that file.

```json
{
  "id": "z1-01",
  "color": "#e53935",
  "color2": "#ffffff",
  "colorName": "Rouge et blanc",
  "zone": 1,
  "grade": "5a",
  "setter": "Alex",
  "photo": "photos/2026-z1-01.jpeg",
  "videos": ["https://www.youtube.com/watch?v=XXXXXXXXXXX"]
}
```

- `id`: unique; also the direct link (`https://.../#z1-01`) and the key of the records in the database
- `color`: hex color of the holds; `colorName`: name shown on the site; `color2`: optional second color (diagonal stripes)
- `zone`: 1 to 4
- `grade`: French scale, one of: `2 3 4a 4b 4c 5a 5b 5c 6a 6a+ 6b 6b+ 6c 6c+ 7a 7a+ 7b 7b+ 7c 7c+`
- `setter`: route setter's name (optional, shown in the detail view)
- `photo`: path to the image (JPEG, WebP or PNG; the name is case-sensitive on GitHub Pages). Empty or a bare folder (`photos/`) shows a placeholder
- `videos`: list of YouTube links (vertical videos / Shorts work), `[]` when none

### Changing boulders for now

There is no edit mode yet. To change boulders: edit `data/boulders.json` on GitHub, then in the Firebase console (Firestore) delete the `boulders/all` document. The next visit to the site recreates it from the file.

## Grades, completions and opinions

- The displayed grade of a boulder is its set `grade`. Climbers never change it.
- A climber taps "J'ai réussi", enters a name, and may add an opinion on the grade: a stepper starts on the set grade and moves one grade at a time, at most 3 grades up or down.
- Opinions need a completion. A completion without opinion is fine.
- Names are matched ignoring capitals and extra spaces. If a name already has a record on the boulder, the climber chooses: update, delete, or use another name.
- The detail view shows who completed the boulder and a bar chart of the opinions around the set grade. The list shows the number of completions and a check mark on the boulders completed by the remembered name.
- Grades are color-coded from blue (2) through green, yellow, orange, red and purple to black (7c+).

## Database (Firestore)

Two documents, so a page load costs two reads:

- `boulders/all`: `{ "list": [ ...boulders ] }`
- `records/all`: `{ "z1-01": { "u_max": { "name": "Max", "vote": "4b" }, ... }, ... }` (`vote` is optional)

Security rules (Firestore > Rules). No sign-in: anyone using the site can write, but nobody can delete a whole document from the site.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /boulders/all {
      allow read: if true;
      allow create, update: if true;
      allow delete: if false;
    }
    match /records/all {
      allow read: if true;
      allow create, update: if true;
      allow delete: if false;
    }
  }
}
```

The old `grades/all` document (previous 1-10 votes) is no longer used and can be deleted in the console.

## Adding a submitted video

Climbers tap "Proposer une vidéo" on a boulder, which opens WhatsApp with a prefilled message naming the boulder (including its `id`). They choose the group and paste their YouTube link. To publish it, add the link to that boulder's `videos` list in `data/boulders.json` (then reset `boulders/all` as described above).

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
