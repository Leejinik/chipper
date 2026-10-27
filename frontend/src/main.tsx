import React from 'react'
import {createRoot} from 'react-dom/client'
import './style.css'
import App from './App'
import ErrorBoundary from './ErrorBoundary'

const container = document.getElementById('root')

const root = createRoot(container!)

root.render(
    <React.StrictMode>
        {/* last resort: errors inside App are caught by its own boundaries first */}
        <ErrorBoundary what="Chipper 화면">
            <App/>
        </ErrorBoundary>
    </React.StrictMode>
)
