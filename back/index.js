import express, { json, response } from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import axios from 'axios'
import { createClient } from '@supabase/supabase-js';

import pool from './db.js'

dotenv.config();

const app = express();

const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0",
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.5",
    "Connection": "keep-alive",
    "DNT": "1",
    "Host": "atn.gold-usergeneratedcontent.net",  // you can hardcode if your images come from this host only
    "Referer": "https://hitomi.la/reader/1867441.html",
    "Upgrade-Insecure-Requests": "1",
};

app.use(cors({
  origin: '*',
  // origin: 'http://localhost:3000' // for dev React app
  // credentials: false,
}));
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 5000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.get('/proxy-image', async (req, res) => {
    const imageUrl = req.query.url
    if (!imageUrl) {
        return res.status(400).send('Missing Url')
    }

    try {
        const response = await axios.get(imageUrl, {
            responseType: 'stream',
            headers,
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
        response.data.pipe(res);
    } catch (error) {
        console.error('Error fetching image:', error.message);
        res.status(500).send(`Error fetching image: ${error.message}`);
    }
})

async function getTagsForMangaList(mangaIds) {
    const { data, error } = await supabase
        .from('manga_tag')
        .select('manga_id, tag:tag_id(tag)')
        .in('manga_id', mangaIds);

    if (error) {
        throw new Error(error.message);
    }

    const tagMap = {};

    for (const row of data) {
        const mangaId = row.manga_id;
        const tag = row.tag?.tag;

        if (!tag) continue;

        if (!tagMap[mangaId]) {
            tagMap[mangaId] = [];
        }

        tagMap[mangaId].push(tag);
    }

    return tagMap;
}


async function getArtist(mangaIds) {
    const { data, error } = await supabase
        .from('manga_artist')
        .select('manga_id, artist:artist_id(artist)')
        .in('manga_id', mangaIds);

    if (error) {
        throw new Error(error.message);
    }

    const artistMap = {};

    for (const row of data) {
        const mangaId = row.manga_id;
        const artist = row.artist?.artist;

        if (!artist) continue;

        if (!artistMap[mangaId]) {
            artistMap[mangaId] = [];
        }

        artistMap[mangaId].push(artist);
    }

    return artistMap;
}


app.get('/', async (req, res) => {
    try {
        const sortBy = req.query.sortBy;
        const order = req.query.order === 'desc' ? false : true;
        const languages = req.query.language;

        let query = supabase
            .from('manga')
            .select('*')
            .limit(1000);

        if (languages) {
            const langs = languages.split(',').map(l => l.trim().toLowerCase());
            query = query.in('language', langs);
        }

        // Apply sorting on fields other than Artist at the DB level
        if (sortBy && sortBy !== 'Artist') {
            query = query.order(sortBy, { ascending: order });
        }

        const { data: mangaList, error } = await query;
        if (error) throw error;

        const mangaIds = mangaList.map(m => m.id);
        const tagsMap = await getTagsForMangaList(mangaIds);
        const artistMap = await getArtist(mangaIds);

        // Enrich manga list with tags and artist arrays
        const mangaWithTags = mangaList.map(manga => ({
            ...manga,
            tags: tagsMap[manga.id] || [],
            artist: artistMap[manga.id] || []
        }));

        // Sort manually by artist on enriched data if requested
        if (sortBy === 'Artist') {
            mangaWithTags.sort((a, b) => {
                const aArtist = Array.isArray(a.artist) ? a.artist[0] : null;
                const bArtist = Array.isArray(b.artist) ? b.artist[0] : null;

                if (!aArtist && !bArtist) return 0;
                if (!aArtist) return 1;
                if (!bArtist) return -1;

                return order ? aArtist.localeCompare(bArtist) : bArtist.localeCompare(aArtist);
            });
        }

        res.json(mangaWithTags);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/search', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Missing search query' });

    // Parse query terms like artist:"hyji" tag:"dog%cow"
    // Split by spaces but keep quotes intact if possible
    const terms = q.match(/(\w+:"[^"]+"|\w+:[^ ]+|[^ ]+)/g) || [];

    const filters = {
        tag: [],
        character: [],
        artist: [],
        mgroup: [],
        parody: [],
        title: [],
        id: []
    };

    // Parse filters, remove quotes, split multiple by '%'
    for (let t of terms) {
        const [key, raw] = t.includes(':') ? t.split(':') : ['title', t];
        let cleaned = raw;
        if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
            cleaned = cleaned.slice(1, -1); // remove quotes
        }
        const values = cleaned.split('%').map(v => v.trim().toLowerCase());
        if (filters[key]) filters[key].push(...values);
        else filters.title.push(t.toLowerCase());
    }

    try {
        // Helper to get manga IDs for exact matches on join tables
        async function getMangaIdsForExactMatch(filterKey, joinTable, refTable, refField) {
            const values = filters[filterKey];
            if (!values.length) return null; // no filter on this

            let sets = [];

            for (const val of values) {
                // Get IDs from ref table by exact match on refField
                const { data: refData, error: refError } = await supabase
                    .from(refTable)
                    .select('id')
                    .eq(refField, val);

                if (refError) throw refError;
                if (!refData.length) return new Set(); // no match = empty set

                const refIds = refData.map(r => r.id);

                // Query join table for manga_ids with these refIds
                const { data: joinData, error: joinErr } = await supabase
                    .from(joinTable)
                    .select('manga_id')
                    .in(`${refTable}_id`, refIds);

                if (joinErr) throw joinErr;
                sets.push(new Set(joinData.map(j => j.manga_id)));
            }

            // Intersection for AND condition across multiple filter values
            let intersection = sets[0];
            for (let i = 1; i < sets.length; i++) {
                intersection = new Set([...intersection].filter(x => sets[i].has(x)));
            }

            return intersection;
        }

        // Get manga ID sets per filter category
        const artistSet = await getMangaIdsForExactMatch('artist', 'manga_artist', 'artist', 'artist');
        const tagSet = await getMangaIdsForExactMatch('tag', 'manga_tag', 'tag', 'tag');
        const parodySet = await getMangaIdsForExactMatch('parody', 'manga_parody', 'parody', 'parody');
        const mgroupSet = await getMangaIdsForExactMatch('mgroup', 'manga_mgroup', 'mgroup', 'mgroup');
        const characterSet = await getMangaIdsForExactMatch('character', 'manga_character', 'character', 'character');

        // For ID filter: exact match, just add to set
        let idSet = null;
        if (filters.id.length) {
            idSet = new Set(filters.id);
        }

        // Partial match for title (OR combined as one ilike with %joined%)
        let titleSet = null;
        if (filters.title.length) {
            const keyword = filters.title.join(' ');
            const { data: titleData, error: titleErr } = await supabase
                .from('manga')
                .select('id')
                .ilike('title', `%${keyword}%`);
            if (titleErr) throw titleErr;
            titleSet = new Set(titleData.map(d => d.id));
        }

        // Combine all filter sets by intersection (AND logic across keys)
        const setsToIntersect = [artistSet, tagSet, parodySet, mgroupSet, characterSet, idSet, titleSet].filter(s => s !== null);

        if (setsToIntersect.length === 0) {
            // No filters, return empty or limit results? Here empty:
            return res.json([]);
        }

        let finalSet = setsToIntersect[0];
        for (let i = 1; i < setsToIntersect.length; i++) {
            finalSet = new Set([...finalSet].filter(x => setsToIntersect[i].has(x)));
        }

        if (finalSet.size === 0) return res.json([]);

        const mangaIds = [...finalSet];

        const { data: manga, error: mangaErr } = await supabase
            .from('manga')
            .select('*')
            .in('id', mangaIds);

        if (mangaErr) throw mangaErr;

        // Enrich with tags and artists
        const tagsMap = await getTagsForMangaList(mangaIds);
        const artistMap = await getArtist(mangaIds);

        const enriched = manga.map(m => ({
            ...m,
            tags: tagsMap[m.id] || [],
            artist: artistMap[m.id] || []
        }));

        res.json(enriched);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Search failed', message: err.message });
    }
});







app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
