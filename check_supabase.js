import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY
);

async function check() {
    console.log('Checking Supabase connection...');
    console.log('URL:', process.env.VITE_SUPABASE_URL);

    const { data, error, status } = await supabase
        .from('tasks')
        .select('*')
        .limit(1);

    if (error) {
        if (error.code === '42P01') {
            console.log('❌ TABLE MISSING: The "tasks" table does not exist yet.');
        } else {
            console.log('❌ ERROR:', error.message);
        }
    } else {
        console.log('✅ SUCCESS: Connection working and "tasks" table found!');
    }
}

check();
