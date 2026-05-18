/**
 * src/data/supabase.js
 *
 * Connection to the Supabase backend.
 *
 * This file holds the configuration for our specific Supabase project
 * and exports a single `supabase` client object that the rest of the app
 * uses to read and write data.
 *
 * Project: timesheet-prod
 * Region: East US (North Virginia)
 */

import { createClient } from '@supabase/supabase-js';

// Public configuration for the timesheet-prod Supabase project.
// The anon key is public by design — it has no special privileges.
// Real security comes from the Row-Level Security policies in the database.
const SUPABASE_URL = 'https://kijumyxoiacvqlqqwqon.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpanVteXhvaWFjdnFscXF3cW9uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwOTIwMTIsImV4cCI6MjA5NDY2ODAxMn0.jR45HHhTjicXX5Wf01u3Pm4BzRuOKbC6Yjx5JiuhQJo';

// The client is created once when this module is first loaded.
// Any other file in the app can `import { supabase } from '../data/supabase.js'`
// and use the same shared client instance.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);