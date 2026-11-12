# Schlummi 🌙

Schlaf-Tagebuch für Babys und Kleinkinder – als Web-App (PWA) für iPhone und Android, gemeinsam für die ganze Familie.

## Funktionen
- Schlaf starten/beenden mit Live-Timer, „vor 5/10/15 min“, Rückgängig, Zeiten anpassen, nachtragen
- Warnung bei vergessenem Stoppen, Überschneidungsprüfung, Markierungen (Zahnt, Krank, Kinderwagen …) und Notizen
- Sanfter Vorschlag für den nächsten Schlaf und Tagesplan bis zur Schlafenszeit (Prognose, ohne „überfällig“)
- Frühgeborene: Richtwerte nach korrigiertem Alter bis 24 Monate; Neugeborene ohne festen Plan
- Tagesrhythmus pro Familie (Schläfchen, Aufwach-/Schlafenszeit, Wachzeit); Schläfchenlänge lernt aus euren Einträgen
- Schlaf der letzten 24 h, 7-Tage-Durchschnitt vs. üblicher Bereich (AASM/NSF), nächtliches Aufwachen
- Verlauf, Bericht für die Kinderarztpraxis (drucken/PDF), Export JSON/CSV, Import
- Mehrere Familien, Einladung per Einmal-Code, Mitglieder verwalten, Familie verlassen/löschen, Konto löschen
- Live-Sync, offline nutzbar (Änderungen werden nachgeholt)
- Push: Erinnerung vor dem nächsten Schlaf, Meldung beim Einschlafen/Aufwachen mit Nachtruhe
- Hell/Dunkel/Automatisch, nachts gedimmt; Hinweise zu sicherem Schlaf und „Wann zur Kinderarztpraxis“

## Aufbau
| Datei | Inhalt |
|---|---|
| `index.html`, `style.css`, `theme.js` | Seite, Design, früh geladenes Theme |
| `app.js` | Oberfläche und Abläufe |
| `store.js` | Datenhaltung: lokal oder Supabase (Live-Sync, Offline-Warteschlange) |
| `sleepdata.js` | Richtwerte und Tagesplanung – auch von der Push-Funktion genutzt |
| `config.js` | Supabase-URL, Publishable Key, VAPID-Public-Key (dürfen öffentlich sein) |
| `sw.js` | Offline-Cache und Push |
| `vendor/`, `fonts/` | Supabase-Bibliothek 2.119.0 und Schrift lokal (keine Drittanbieter) |
| `datenschutz.html`, `impressum.html` | Rechtstexte |
| `supabase/` | `schema.sql` → `push.sql` → `03_haertung.sql`, Edge Function `functions/push/` |
| `tests/` | Tests der Planungslogik: `npm test` |

## Sicherheit
- Row Level Security: jede Familie sieht nur ihre Daten; Schreibrechte auf Spaltenebene
- Einladungscode 10 Zeichen (~50 Bit), 7 Tage gültig, einmalig, max. 10 Versuche/Stunde
- Push-Abos validiert (nur echte Push-Dienste, max. 5 Geräte), Funktion fehlertolerant mit Zeitlimits
- Content-Security-Policy, keine externen Skripte oder Schriften

## Betrieb
- Live: https://nicolasklotz89-ux.github.io/schlummi/
- Supabase-Projekt „Schlummi“ (Frankfurt). Site URL ist auf die Pages-Adresse gesetzt, Mindestpasswortlänge 8, E-Mail-Bestätigung an. („Leaked password protection“ gibt es erst im Pro-Tarif.)
- Kostenloser Supabase-Tarif pausiert Projekte nach 7 Tagen ohne Nutzung – bei täglicher Nutzung kein Thema.
- Veröffentlichen: GitHub-Repo → *Settings → Pages → main / root*. Auf dem Handy öffnen → „Zum Home-Bildschirm“.
- Der Auftragsverarbeitungsvertrag (DPA) von Supabase ist Teil der Nutzungsbedingungen – keine separate Unterschrift nötig.
- Datenschutz und Impressum sind ausgefüllt; vor Weitergabe an andere Familien rechtlich prüfen lassen.
