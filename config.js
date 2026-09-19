// Supabase project for saving/sharing itineraries.
// The anon/public key is meant to ship in client code — access is limited by the
// table's row-level-security policies (insert/update only; reads go through the
// get_plan(id) function, so no one can list every plan).
window.SUPABASE = {
  url: "https://soepsvqtbyujhxnvtfly.supabase.co/rest/v1",
  anon: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNvZXBzdnF0Ynl1amh4bnZ0Zmx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3NzU2NDgsImV4cCI6MjEwNTM1MTY0OH0.NAwHlmHosLPwN464nNa_Py5D2bqX496bziIOFkxuSXE",
};
