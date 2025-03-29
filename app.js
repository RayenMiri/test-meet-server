import express from "express";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();
const app = express();


app.use(cors());
app.use(express.json());
app.use(limiter);
app.use(express.urlencoded({ limit: "50mb", extended: true }));


export default app;
