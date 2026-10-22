# USVME

Static mobile-first site: zone map, boulder list with French grades, detail view with completions, climbers' opinions on the grade and "Beta" videos.
Hosted on GitHub Pages. Boulders and climbers' records are stored in Firebase Firestore (free Spark plan).

## Files

- `index.html`, `style.css`, `app.js`: the site itself
- `firebase-config.js`: Firebase project settings (public identifiers, not secrets)
- `data/boulders.json`: the boulder list. It is the starting data (see "Boulders"), and a backup
- `data/zones.json`: the zone polygons and the "Tout" button (coordinates from the floor plan)
- `photos/`: the photos, referenced by the `photo` field of each boulder
- `photos/index.json`: the list of photo file names offered by the photo picker (see "Managing boulders")

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

### Managing boulders (power users)

Power users (see below) get a "Gestion" section at the bottom of the main page with "Ajouter un bloc" and "Utilisateurs avancés", and a "Modifier ce bloc" button at the bottom of each boulder. The form edits zone, grade, colors (one or two), color name, setter, photo and YouTube links. A new boulder gets an automatic id (`z2-05` = next free number in its zone). The id never changes afterwards, even if the zone is changed, so completions and links stay valid. Deleting a boulder is permanent and also deletes its completions and opinions.

Photos stay in GitHub. After uploading a photo to `photos/`, add its file name to `photos/index.json` (a plain list, for example `["2026-z1-01.jpeg", "2026-z2-03.jpeg"]`) so it appears in the picker.

`data/boulders.json` is now only the first-time seed and a fallback when the database is unreachable.

## Power users

Power users also have a "Supprimer un utilisateur" button in the Gestion section: it lists everyone with completions and erases all of one user's completions and opinions, after a confirmation.

The list of power users is stored in Firestore (`config/powerusers`, created with `admin` on first load). A user is a power user if the name they sign in with is in the list (capitals ignored). "admin" cannot be removed. This only keeps the extra buttons away from ordinary users; it is not a security measure.

## Users, completions and opinions

- There are no accounts and no password. A visitor starts as a guest ("Invité"). They sign in by typing a name, either from the header or when they tap "Valider". The name is remembered on the phone; the same name on another phone gives the same records.
- Names are matched ignoring capitals and extra spaces. Someone can sign out from the header (back to guest).
- Tapping "Valider" records the completion at once, with no confirmation. A completed boulder then offers two buttons: "Noter" and "Annuler" (which removes the completion and the opinion, with no confirmation).
- "Noter" opens a - / + stepper that starts on the set grade (or on the climber's previous opinion) and moves one grade at a time, at most 3 grades up or down. "Valider" saves it; "Retirer mon avis" removes just the opinion.
- Opinions never change the displayed grade, which is always the set `grade`.
- The header shows "USVME", the signed-in user, and (second line) the number of completed boulders out of all boulders (example 12/27) and the set grade of the hardest completed boulder. Tapping that line opens the ranking of all users (completed boulders descending, then hardest grade).
- The level filter is a single - / + selector ("Tous", 2, 3, 4, 5, 6, 7) that shows the boulders of that group of grades (6 = 6a to 6c+); the chip keeps the grade color. The round arrow resets it.
- The detail view has a "Validé : (n)" title whose oval opens a pop-up with the climbers and their opinions, and shows a bar chart of the opinions around the set grade. The list shows the number of completions and a check mark on the boulders completed by the signed-in user.
- Grades are color-coded from blue (2) through green, yellow, orange, red and purple to black (7c+).
- Zooming (pinch and double-tap) is disabled.

## Database (Firestore)

Three documents, so a page load costs three reads:

- `boulders/all`: `{ "list": [ ...boulders ] }`
- `records/all`: `{ "z1-01": { "u_max": { "name": "Max", "vote": "4b" }, ... }, ... }` (`vote` is optional)
- `config/powerusers`: `{ "list": ["admin", "Léa"] }`

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
    match /config/powerusers {
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
