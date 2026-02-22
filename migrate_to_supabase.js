import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const supabase = createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY
);

async function migrate() {
    console.log('--- Migration Started ---');

    try {
        // 1. Get local tasks
        const localTasks = await prisma.task.findMany();
        console.log(`Found ${localTasks.length} local tasks.`);

        if (localTasks.length === 0) {
            console.log('No tasks to migrate.');
            return;
        }

        // 2. Format for Supabase
        const formattedTasks = localTasks.map(t => ({
            id: t.id,
            title: t.title,
            description: t.description,
            startTime: t.startTime.toISOString(),
            endTime: t.endTime.toISOString(),
            completed: t.completed,
            completedAt: t.completedAt ? t.completedAt.toISOString() : null,
            category: t.category,
            priority: t.priority,
            color: t.color,
            reminder: t.reminder,
            reminderSent: t.reminderSent
        }));

        // 3. Push to Supabase
        const { data, error } = await supabase
            .from('tasks')
            .upsert(formattedTasks, { onConflict: 'id' });

        if (error) {
            if (error.code === '42P01') {
                console.error('ERROR: Table "tasks" does not exist in Supabase.');
                console.log('Please run the SQL I provided in the Supabase Dashboard.');
            } else {
                console.error('Supabase Error:', error);
            }
            return;
        }

        console.log('Successfully pushed tasks to Supabase! 🎉');
    } catch (err) {
        console.error('Migration failed:', err.message);
    } finally {
        await prisma.$disconnect();
    }
}

migrate();
