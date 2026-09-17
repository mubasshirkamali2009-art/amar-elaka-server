const dns = require("node:dns");
dns.setServers(["1.1.1.1", "8.8.8.8"]);
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const turf = require('@turf/turf');

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4001;

app.use(cors({
    origin: "http://localhost:3000",
    credentials: true,
}));
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Server running okay');
});

const uri = process.env.MONGO_DB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

const LOOP_CLOSURE_TOLERANCE_METERS = 50;

// Reverse-geocode a [lat, lng] point into a division/district name using
// OpenStreetMap's free Nominatim service. No API key needed.
async function reverseGeocode(lat, lng) {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=8&addressdetails=1`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'ElakaRunBD/1.0 (territory-run-app)' },
        });
        const data = await res.json();
        const address = data.address || {};
        return {
            district: address.state_district || address.county || address.city || 'Unknown District',
            division: address.state || 'Unknown Division',
        };
    } catch (error) {
        console.error('Reverse geocoding failed:', error);
        return { district: 'Unknown District', division: 'Unknown Division' };
    }
}

async function run() {
    try {
        await client.connect();

        const database = client.db("territoryRunDB");
        const usersCollection = database.collection("users");
        const runsCollection = database.collection("runs");
        const territoriesCollection = database.collection("territories");

        // =====================================================
        // RUN STOP — loop closure, territory claim, steal logic
        // =====================================================
        app.post('/api/runs/:id/stop', async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ error: 'Invalid run id' });
                }

                const existingRun = await runsCollection.findOne({ _id: new ObjectId(id) });
                if (!existingRun) {
                    return res.status(404).send({ error: 'Run not found' });
                }

                const coords = existingRun.route?.coordinates || [];
                if (coords.length < 3) {
                    await runsCollection.updateOne(
                        { _id: new ObjectId(id) },
                        { $set: { status: 'stopped', stoppedAt: new Date() } }
                    );
                    return res.send({ success: true, loopClosed: false, message: 'Run too short to form a loop' });
                }

                const startPoint = turf.point(coords[0]);
                const endPoint = turf.point(coords[coords.length - 1]);
                const closureDistance = turf.distance(startPoint, endPoint, { units: 'meters' });
                const loopClosed = closureDistance <= LOOP_CLOSURE_TOLERANCE_METERS;

                let territoryResult = null;

                if (loopClosed) {
                    const ring = [...coords, coords[0]];
                    const polygon = turf.polygon([ring]);
                    const areaSqMeters = turf.area(polygon);
                    const areaKm2 = areaSqMeters / 1_000_000;

                    // Centroid used to determine which district/division this territory falls in
                    const centroid = turf.centroid(polygon);
                    const [centroidLng, centroidLat] = centroid.geometry.coordinates;
                    const { district, division } = await reverseGeocode(centroidLat, centroidLng);

                    const existingTerritories = await territoriesCollection.find({}).toArray();
                    const stolenFrom = [];

                    for (const existing of existingTerritories) {
                        const existingPolygon = turf.polygon(existing.area.coordinates);
                        const overlaps = turf.booleanOverlap(polygon, existingPolygon) ||
                            turf.booleanContains(existingPolygon, polygon) ||
                            turf.booleanContains(polygon, existingPolygon);

                        if (overlaps) {
                            stolenFrom.push(existing.ownerId);
                            // Territory is removed from the previous owner entirely —
                            // this is the "delete on steal" behavior.
                            await territoriesCollection.deleteOne({ _id: existing._id });
                        }
                    }

                    const territory = {
                        ownerId: existingRun.userId,
                        runId: existingRun._id,
                        area: { type: 'Polygon', coordinates: [ring] },
                        areaKm2,
                        district,
                        division,
                        claimedAt: new Date(),
                    };

                    const insertResult = await territoriesCollection.insertOne(territory);
                    territoryResult = { _id: insertResult.insertedId, ...territory, stolenFrom };
                }

                await runsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status: 'stopped', stoppedAt: new Date(), loopClosed } }
                );

                res.send({ success: true, loopClosed, territory: territoryResult });
            } catch (error) {
                console.error(error);
                res.status(500).send({ error: 'Failed to stop run and process territory' });
            }
        });

        // =====================================================
        // TERRITORY ENDPOINTS
        // =====================================================

        app.get('/api/territories', async (req, res) => {
            try {
                const { scope = 'all', value, lat, lng, radius } = req.query;
                let territories = await territoriesCollection.find({}).toArray();

                if (scope === 'division' && value) {
                    territories = territories.filter(t => t.division === value);
                } else if (scope === 'district' && value) {
                    territories = territories.filter(t => t.district === value);
                } else if (scope === 'nearby' && lat && lng) {
                    const radiusKm = Number(radius) || 5;
                    const userPoint = turf.point([Number(lng), Number(lat)]);
                    territories = territories.filter(t => {
                        const centroid = turf.centroid(turf.polygon(t.area.coordinates));
                        return turf.distance(userPoint, centroid, { units: 'kilometers' }) <= radiusKm;
                    });
                }

                if (territories.length === 0) {
                    return res.send([]);
                }

                const ownerIds = [...new Set(territories.map(t => t.ownerId))]
                    .filter(id => ObjectId.isValid(id))
                    .map(id => new ObjectId(id));

                const owners = await usersCollection.find({ _id: { $in: ownerIds } }).toArray();

                const withOwnerInfo = territories.map(t => {
                    const owner = owners.find(o => o._id.toString() === t.ownerId);
                    return {
                        _id: t._id,
                        ownerId: t.ownerId,
                        ownerName: owner?.name || 'Unknown Runner',
                        area: t.area,
                        areaKm2: t.areaKm2,
                        district: t.district || null,
                        division: t.division || null,
                        claimedAt: t.claimedAt,
                    };
                });

                res.send(withOwnerInfo);
            } catch (error) {
                console.error(error);
                res.status(500).send({ error: 'Failed to load territories' });
            }
        });

        // =====================================================
        // LEADERBOARD — with scope filters
        // =====================================================
        // scope=all              -> whole Bangladesh
        // scope=division&value=X -> that division only
        // scope=district&value=X -> that district only
        // scope=nearby&lat=&lng=&radius= -> within radius km of a point
        app.get('/api/leaderboard', async (req, res) => {
            try {
                const { scope = 'all', value, lat, lng, radius } = req.query;
                let territories = await territoriesCollection.find({}).toArray();

                if (scope === 'division' && value) {
                    territories = territories.filter(t => t.division === value);
                } else if (scope === 'district' && value) {
                    territories = territories.filter(t => t.district === value);
                } else if (scope === 'nearby' && lat && lng) {
                    const radiusKm = Number(radius) || 5;
                    const userLat = Number(lat);
                    const userLng = Number(lng);

                    territories = territories.filter(t => {
                        const ring = t.area.coordinates[0];
                        const centLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
                        const centLng = ring.reduce((s, p) => s + p[0], 0) / ring.length;
                        const centroid = turf.point([centLng, centLat]);
                        const userPoint = turf.point([userLng, userLat]);
                        const distanceKm = turf.distance(userPoint, centroid, { units: 'kilometers' });
                        return distanceKm <= radiusKm;
                    });
                }
                // scope === 'all' -> no filtering

                const grouped = {};
                for (const t of territories) {
                    if (!grouped[t.ownerId]) {
                        grouped[t.ownerId] = { ownerId: t.ownerId, totalAreaKm2: 0, territoryCount: 0 };
                    }
                    grouped[t.ownerId].totalAreaKm2 += t.areaKm2;
                    grouped[t.ownerId].territoryCount += 1;
                }

                const leaderboard = Object.values(grouped).sort((a, b) => b.totalAreaKm2 - a.totalAreaKm2);

                const ownerIds = leaderboard
                    .map(entry => entry.ownerId)
                    .filter(id => ObjectId.isValid(id))
                    .map(id => new ObjectId(id));

                const owners = await usersCollection.find({ _id: { $in: ownerIds } }).toArray();

                const result = leaderboard.map(entry => {
                    const owner = owners.find(o => o._id.toString() === entry.ownerId);
                    return {
                        userId: entry.ownerId,
                        name: owner?.name || 'Unknown Runner',
                        totalAreaKm2: entry.totalAreaKm2,
                        territoryCount: entry.territoryCount,
                    };
                });

                res.send(result);
            } catch (error) {
                console.error(error);
                res.status(500).send({ error: 'Failed to load leaderboard' });
            }
        });

        // =====================================================
        // META — distinct divisions/districts that already have claimed territory
        // (used to populate filter dropdowns with only real, non-empty options)
        // =====================================================
        app.get('/api/meta/regions', async (req, res) => {
            try {
                const territories = await territoriesCollection.find({}).toArray();
                const divisions = [...new Set(territories.map(t => t.division).filter(Boolean))].sort();
                const districts = [...new Set(territories.map(t => t.district).filter(Boolean))].sort();
                res.send({ divisions, districts });
            } catch (error) {
                console.error(error);
                res.status(500).send({ error: 'Failed to load regions' });
            }
        });

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
    }
}
run().catch(console.dir);

app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://localhost:${port}`);
});