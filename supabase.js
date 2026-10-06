const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be configured.");
}
if (!supabasePublishableKey.startsWith("sb_publishable_")) {
  throw new Error("SUPABASE_PUBLISHABLE_KEY must contain a Supabase publishable key.");
}

const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false
  }
});

const requiredTables = ["competitions", "students", "problems", "submissions", "results"];

async function checkSupabaseConnection() {
  const tables = await Promise.all(requiredTables.map(async table => {
    const { error } = await supabase
      .from(table)
      .select("*", { count: "exact", head: true });

    if (error) {
      console.error(`Supabase request failed for ${table}: ${error.message}`);
      return { table, connected: false, error: error.message };
    }

    return { table, connected: true };
  }));

  return {
    connected: tables.every(table => table.connected),
    tables
  };
}

module.exports = { supabase, checkSupabaseConnection };
