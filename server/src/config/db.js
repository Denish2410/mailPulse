import mongoose from 'mongoose';

/**
 * Connect to MongoDB database using Mongoose.
 * Reads the connection URI from process.env.MONGODB_URI.
 *
 * @returns {Promise<typeof mongoose>} Resolved Mongoose instance
 * @throws {Error} If MONGODB_URI is undefined or connection fails
 */
export const connectDB = async () => {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    const errorMsg = 'MONGODB_URI is not defined in environment variables. Please check your .env configuration.';
    console.error(`[Database Error] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  try {
    const conn = await mongoose.connect(uri);
    console.log(`[Database] MongoDB connected successfully: ${conn.connection.host}/${conn.connection.name}`);
    return conn;
  } catch (error) {
    // Log informative message without exposing credentials or sensitive connection strings
    console.error(`[Database Error] Connection failed: ${error.message}`);
    throw new Error(`Failed to connect to MongoDB: ${error.message}`);
  }
};

export default connectDB;
