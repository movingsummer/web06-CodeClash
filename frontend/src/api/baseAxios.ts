import axios from "axios";
import { useLoginStore } from "../store/useLogin";
import { refreshAccessToken, refreshErrorHandle } from "./refresh";

export const baseURL = process.env.REACT_APP_API_URL;

export const baseAxios = axios.create({
  baseURL,
  headers: {
    "Content-Type": "application/json; charset=UTF-8",
    WithCredentials: "true",
    Authorization: "Bearer " + useLoginStore.getState().accessToken,
  },
});

baseAxios.interceptors.request.use(refreshAccessToken, refreshErrorHandle);
