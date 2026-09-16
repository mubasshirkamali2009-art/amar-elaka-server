const dns = require("node:dns");
dns.setServers(["1.1.1.1", "8.8.8.8"]);
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express();
const port = process.env.PORT || 4001;

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

async function run() {
    try {
        await client.connect();

        const database = client.db("territoryRunDB");
        const usersCollection = database.collection("users");
        const runsCollection = database.collection("runs");
        const territoriesCollection = database.collection("territories");

        // =====================================================
        // TERRITORY ENDPOINTS
        // =====================================================

        app.get('/api/territories', async (req, res) => {
            try {
                const territories = await territoriesCollection.find({}).toArray();

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
                        claimedAt: t.claimedAt,
                    };
                });

                res.send(withOwnerInfo);
            } catch (error) {
                console.error(error);
                res.status(500).send({ error: 'Failed to load territories' });
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