// Where the trip data lives.
//
// A Google Apps Script web app in front of a private Google Sheet, replacing the
// free Supabase project that died three times (deleted Aug 2026, paused 2026-09-30,
// gone again around 2026-10-08 while a keep-alive was still pinging it). The Sheet
// sits in the owner's own Drive, so there is no free tier to fall off and nothing
// that gets reclaimed for being quiet.
//
// This URL is public, exactly as the old anon key was. It is not the secret: anyone
// who has it can ask the backend about a plan id, and the PLAN ID IS THE PASSWORD.
// The backend has no operation that lists plan ids, so a caller who does not already
// know the id learns nothing — a wrong id returns null.
//
// Setup, and what to do if this URL ever needs replacing: see apps-script/SETUP.md.
window.BACKEND = {
  url: "https://script.google.com/macros/s/AKfycbyqemULKl0XwFBAb2Ag8qhAmHSgJHE67NuMQt7N5U-bTkEBH5sWH3gZ_ggXcwNLtm9a1g/exec",
};
