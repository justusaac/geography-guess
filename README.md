Self-host instructions:

1. Install PostgreSQL, Node.js, npm (I used v10, v22, v10 respectively)

2. Get a Google Cloud API key and make sure it is allowed to use the Maps Javascript API

3. Create a PostgreSQL database

4. Create a file `.env` with the same format as the file `example.env` with the placeholders for the database connection information and Google API key filled in

5. Run (from the root directory) `npm install`

6. Run `node db/create_tables.js`

7. Run `node server.js`

8. Go to `http://localhost:80` in the browser to see the webpage, however there will be no maps so there is nothing to do on there yet. You might want to run the script `node map_generation/generate_polygonal_map.js` to find locations to play on, or you can upload maps from the webpage.