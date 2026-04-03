import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://kipgpzfbtjkpegexipbl.supabase.co'
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpcGdwemZidGprcGVnZXhpcGJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNTAxMTEsImV4cCI6MjA5MDcyNjExMX0.WZv1HWne3v_dndTfhBDwfaYxGgvVPhJvJJigAaauiUo'

export const supabase = createClient(supabaseUrl, supabaseKey)
